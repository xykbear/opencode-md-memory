#!/usr/bin/env python3
"""opencode-md-memory embeddings service.

Loads a local ONNX embedding model (onnxruntime + tokenizers) and serves an
**OpenAI-compatible** `POST /v1/embeddings` endpoint (plus `/health`). Speaking the
same protocol as llama.cpp / Ollama / TEI / LM Studio / OpenAI means the plugin can
talk to any of them — and to this bundled server — through ONE interface.

Model resolution (in order):
    1. MDM_EMBED_MODEL_DIR / KB_EMBED_MODEL_DIR / EMBED_MODEL_DIR
    2. ~/.opencode-md-memory/models/<model>/onnx        (plugin-owned)
    3. auto-download into #2 when missing (unless MDM_EMBED_AUTO_FETCH=0)

Env:
    MDM_EMBED_MODEL_DIR / KB_EMBED_MODEL_DIR / EMBED_MODEL_DIR  model directory override
    MDM_EMBED_AUTO_FETCH                   "0" disables auto-download of a missing model
    HF_ENDPOINT                            download mirror (default https://huggingface.co)
    EMBED_SERVER_PORT                      default port (48611)
    EMBED_SERVER_IDLE_TIMEOUT              default idle timeout in seconds (1800)

The server exits itself after --idle-timeout seconds without any request.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_MODEL_NAME = "embeddinggemma-2"
DEFAULT_MODEL_REPO = "onnx-community/embeddinggemma-2-ONNX"
# 纯文本所需文件：(HF 仓库相对路径, 本地落点)。本地布局与手工安装一致：
# 权重在 <model>/onnx/，config/tokenizer 在 <model>/（加载器按此查找）
MODEL_FILES = (
    ("config.json", "root"),
    ("tokenizer.json", "root"),
    ("onnx/model_quantized.onnx", "onnx"),
    ("onnx/model_quantized.onnx_data", "onnx"),
)
DEFAULT_PORT = 48611


def log(msg: str):
    """stdout 日志。插件进程重启后旧服务成孤儿、stdout 管道断裂时 print 会抛
    BrokenPipeError 导致请求 500——这里吞掉，让日志失败不影响请求。"""
    try:
        print(msg, flush=True)
    except (BrokenPipeError, OSError):
        pass


def _own_model_dir(model_name: str) -> Path:
    return Path.home() / ".opencode-md-memory/models" / model_name / "onnx"


def resolve_model_dir(model_name: str | None = None) -> Path | None:
    for env_name in ("MDM_EMBED_MODEL_DIR", "KB_EMBED_MODEL_DIR", "EMBED_MODEL_DIR"):
        v = os.environ.get(env_name)
        if v and Path(v).is_dir():
            return Path(v)
    d = _own_model_dir(model_name or DEFAULT_MODEL_NAME)
    return d if d.is_dir() else None


def fetch_model(onnx_dir: Path, repo: str, revision: str = "main") -> bool:
    """下载纯文本所需文件：权重到 onnx_dir，config/tokenizer 到 onnx_dir.parent。

    与手工安装布局一致（`<model>/onnx/model_quantized.onnx` + `<model>/tokenizer.json`）。
    每个文件先写 `.part` 再原子改名——中断只会留下 `.part`，绝不产生"非空但截断"的半成品
    被后续启动误判为完整（否则 onnxruntime 会报外部数据截断且永不重下）。
    """
    import urllib.request
    base = (os.environ.get("HF_ENDPOINT") or "https://huggingface.co").rstrip("/")
    try:
        for remote, where in MODEL_FILES:
            target_dir = onnx_dir if where == "onnx" else onnx_dir.parent
            target_dir.mkdir(parents=True, exist_ok=True)
            out = target_dir / remote.split("/", 1)[-1]
            if out.is_file() and out.stat().st_size > 0:
                continue
            tmp = out.with_name(out.name + ".part")
            url = f"{base}/{repo}/resolve/{revision}/{remote}"
            log(f"[fetch] {remote} <- {url}")
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as w:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    w.write(chunk)
            os.replace(tmp, out)
        return True
    except Exception as e:
        log(f"[fetch] failed: {e}")
        return False


def ensure_model_dir(model_name: str | None = None, repo: str = DEFAULT_MODEL_REPO) -> Path | None:
    """解析模型目录；builtin 且缺失且允许时自动拉取到插件自有目录。"""
    d = resolve_model_dir(model_name)
    if d is not None:
        return d
    if os.environ.get("MDM_EMBED_AUTO_FETCH", "1") == "0":
        return None
    name = model_name or DEFAULT_MODEL_NAME
    dest = _own_model_dir(name)
    if not fetch_model(dest, repo):
        return None
    return dest if (dest / "model_quantized.onnx").is_file() else None


def build_embedder(model_dir: Path):
    """Load ONNX via onnxruntime + tokenizers; returns embed(texts) -> list[list[float]].

    兼容 EmbeddingGemma-2（多语言；多模态模型纯文本时对 image/video/audio 特征喂空
    张量，取 sentence_embedding）与普通文本模型（单输出 + 可选 token_type_ids）。
    """
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    q = model_dir / "model_quantized.onnx"
    full = model_dir / "model.onnx"
    onnx_path = q if q.is_file() else full
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    tp = model_dir.parent / "tokenizer.json"
    tok = Tokenizer.from_file(str(tp if tp.is_file() else model_dir / "tokenizer.json"))
    input_names = [i.name for i in session.get_inputs()]
    outputs = {o.name: o for o in session.get_outputs()}
    out_name = ("sentence_embedding" if "sentence_embedding" in outputs
                else session.get_outputs()[0].name)
    out_shape = outputs[out_name].shape
    pooled = len(out_shape) == 2
    dim = int(out_shape[-1])
    modality = [n for n in input_names
                if n not in ("input_ids", "attention_mask", "token_type_ids")]
    max_len = 8192

    def embed(texts: list[str], batch_size: int = 32):
        n = len(texts)
        if n == 0:
            return []
        encs = [tok.encode(t) for t in texts]
        ids = [e.ids for e in encs]
        maxlen = min(max(len(x) for x in ids), max_len)
        ids_arr = np.zeros((n, maxlen), dtype=np.int64)
        att_arr = np.zeros((n, maxlen), dtype=np.int64)
        for i, x in enumerate(ids):
            x = x[:maxlen]
            ids_arr[i, : len(x)] = x
            att_arr[i, : len(x)] = 1

        outs = []
        for s in range(0, n, batch_size):
            chunk_ids = ids_arr[s : s + batch_size]
            chunk_att = att_arr[s : s + batch_size]
            feed = {"input_ids": chunk_ids, "attention_mask": chunk_att}
            if "token_type_ids" in input_names:
                feed["token_type_ids"] = np.zeros_like(chunk_ids)
            for m in modality:                       # Gemma-2 多模态：纯文本喂空
                feed[m] = np.zeros((0, 512), dtype=np.float32)
            result = session.run([out_name], feed)[0]
            if not pooled and result.ndim == 3:
                mask = chunk_att[:, :, None]
                denom = np.maximum(mask.sum(axis=1), 1).astype(np.float32)
                result = (result * mask).sum(axis=1) / denom
            outs.append(result.astype(np.float32))
        vecs = np.concatenate(outs, axis=0)
        norm = np.linalg.norm(vecs, axis=1, keepdims=True)
        return (vecs / np.maximum(norm, 1e-9)).tolist()

    return embed


class Handler(BaseHTTPRequestHandler):
    embedder = None  # set by server
    model_dir = None  # resolved model dir (reported by /health for index invalidation)
    idle_timeout = 1800  # seconds without any request before self-exit
    _last_activity = None  # set by server

    def log_message(self, fmt, *args):
        pass

    def _touch(self):
        if Handler._last_activity is not None:
            Handler._last_activity[0] = time.monotonic()

    def do_POST(self):
        self._touch()
        if self.path.rstrip("/") not in ("/v1/embeddings", "/embeddings"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            inp = body.get("input", [])
            texts = [inp] if isinstance(inp, str) else list(inp)
            if not texts:
                self._json(400, {"error": {"message": "input must be a non-empty string or array"}})
                return
            if self.embedder is None:
                self._json(503, {"error": {"message": "embedder not loaded"}})
                return
            t0 = time.monotonic()
            vectors = type(self).embedder(texts)
            log(f"[embed] n={len(texts)} elapsed={(time.monotonic() - t0) * 1000:.1f}ms")
            self._json(200, {
                "object": "list",
                "data": [
                    {"object": "embedding", "index": i, "embedding": v}
                    for i, v in enumerate(vectors)
                ],
                "model": type(self).model_dir,
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            })
        except Exception as e:
            self._json(500, {"error": {"message": str(e)}})

    def do_GET(self):
        self._touch()
        if self.path == "/health":
            self._json(200, {"ok": True, "model": type(self).model_dir})
        else:
            self.send_error(404)

    def _json(self, code: int, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("EMBED_SERVER_PORT", DEFAULT_PORT)))
    parser.add_argument("--model-dir", type=str, default=None)
    parser.add_argument("--model-name", type=str, default=None)
    parser.add_argument("--model-repo", type=str, default=DEFAULT_MODEL_REPO)
    parser.add_argument("--idle-timeout", type=int,
                        default=int(os.environ.get("EMBED_SERVER_IDLE_TIMEOUT", "1800")))
    args = parser.parse_args()

    model_dir = Path(args.model_dir) if args.model_dir else ensure_model_dir(args.model_name, args.model_repo)
    if model_dir is None:
        print(f"ERROR: embedding model not found (model={args.model_name or DEFAULT_MODEL_NAME}). "
              f"Set MDM_EMBED_MODEL_DIR or allow auto-fetch (MDM_EMBED_AUTO_FETCH).", file=sys.stderr)
        sys.exit(1)

    t0 = time.monotonic()
    Handler.embedder = build_embedder(model_dir)
    Handler.model_dir = str(model_dir)
    log(f"model loaded in {time.monotonic() - t0:.2f}s")
    Handler.idle_timeout = args.idle_timeout
    Handler._last_activity = [time.monotonic()]

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"embeddings service on 127.0.0.1:{args.port} "
        f"(model: {model_dir}, idle-timeout: {args.idle_timeout}s)")

    def idle_watchdog():
        while True:
            time.sleep(5)
            if Handler._last_activity is None:
                return
            idle = time.monotonic() - Handler._last_activity[0]
            if idle >= Handler.idle_timeout:
                log(f"embeddings service idle for {idle:.0f}s, shutting down")
                threading.Thread(target=server.shutdown, daemon=True).start()
                return

    threading.Thread(target=idle_watchdog, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
