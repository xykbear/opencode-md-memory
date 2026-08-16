#!/usr/bin/env python3
"""opencode-md-memory embedding server.

Local HTTP server that loads an ONNX embedding model (nomic-embed-text-v1) via
onnxruntime + tokenizers and exposes a batch `/embed` endpoint. The opencode
plugins call this over HTTP because opencode's embedded Bun runtime cannot load
onnxruntime native bindings reliably; plain Python is cross-platform (macOS,
Windows, Linux) and stable.

Usage:
    python embed_server.py [--port PORT] [--model-dir DIR] [--idle-timeout SECONDS]

Env:
    MDM_EMBED_MODEL_DIR / EMBED_MODEL_DIR  model directory override (default:
        ~/.opencode-md-memory/models/nomic-embed-text-v1/onnx)
    EMBED_SERVER_PORT                      default port (48611)
    EMBED_SERVER_IDLE_TIMEOUT              default idle timeout in seconds (1800)

The server exits itself after --idle-timeout seconds without any request, so
it does not linger after the plugins stop using it.
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

DEFAULT_MODEL_DIR = Path.home() / ".opencode-md-memory/models/nomic-embed-text-v1/onnx"
DEFAULT_PORT = 48611


def resolve_model_dir() -> Path | None:
    for env_name in ("MDM_EMBED_MODEL_DIR", "EMBED_MODEL_DIR"):
        v = os.environ.get(env_name)
        if v and Path(v).is_dir():
            return Path(v)
    d = DEFAULT_MODEL_DIR
    return d if d.is_dir() else None


def build_embedder(model_dir: Path):
    """Load ONNX model via onnxruntime + tokenizers; returns embed(texts) -> list[list[float]]."""
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    q = model_dir / "model_quantized.onnx"
    full = model_dir / "model.onnx"
    onnx_path = q if q.is_file() else full
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    tok = Tokenizer.from_file(str(model_dir.parent / "tokenizer.json"))
    out = session.get_outputs()[0]
    pooled = len(out.shape) == 2
    dim = int(out.shape[-1])
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
            result = session.run(
                None,
                {
                    "input_ids": chunk_ids,
                    "token_type_ids": np.zeros_like(chunk_ids),
                    "attention_mask": chunk_att,
                },
            )[0]
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
    idle_timeout = 1800  # seconds without any request before self-exit
    _last_activity = None  # set by server

    def log_message(self, fmt, *args):
        if self.path == "/embed":
            print(f"[embed-request] {self.path}", flush=True)

    def _touch(self):
        if Handler._last_activity is not None:
            Handler._last_activity[0] = time.monotonic()

    def do_POST(self):
        self._touch()
        if self.path != "/embed":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            texts = body.get("texts", [])
            if not isinstance(texts, list) or not texts:
                self._json(400, {"error": "texts must be a non-empty array"})
                return
            if self.embedder is None:
                self._json(503, {"error": "embedder not loaded"})
                return
            # 用 type(self) 引用类属性，避免实例访问时被当作绑定方法（self 被当第一个参数传入）
            vectors = type(self).embedder(texts)
            self._json(200, {"vectors": vectors, "dim": len(vectors[0]) if vectors else 0})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_GET(self):
        self._touch()
        if self.path == "/health":
            self._json(200, {"ok": True, "dim": None})
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
    parser.add_argument("--idle-timeout", type=int,
                        default=int(os.environ.get("EMBED_SERVER_IDLE_TIMEOUT", "1800")))
    args = parser.parse_args()

    model_dir = Path(args.model_dir) if args.model_dir else resolve_model_dir()
    if model_dir is None:
        print("ERROR: embedding model not found. Set MDM_EMBED_MODEL_DIR or EMBED_MODEL_DIR.", file=sys.stderr)
        sys.exit(1)

    Handler.embedder = build_embedder(model_dir)
    Handler.idle_timeout = args.idle_timeout
    Handler._last_activity = [time.monotonic()]

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"embedding server listening on 127.0.0.1:{args.port} "
          f"(model: {model_dir}, idle-timeout: {args.idle_timeout}s)", flush=True)

    def idle_watchdog():
        while True:
            time.sleep(5)
            if Handler._last_activity is None:
                return
            idle = time.monotonic() - Handler._last_activity[0]
            if idle >= Handler.idle_timeout:
                print(f"embedding server idle for {idle:.0f}s, shutting down", flush=True)
                threading.Thread(target=server.shutdown, daemon=True).start()
                return

    threading.Thread(target=idle_watchdog, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
