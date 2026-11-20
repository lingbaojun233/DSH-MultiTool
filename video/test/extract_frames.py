#!/usr/bin/env python
"""extract_frames.py -- sample N frames from a local video, emit JSON on stdout.

Local-dev helper: production path is either the browser (upload) or ffmpeg (URL).
Kept because it is the quickest way to test the analyzer on a real file.
"""
import argparse
import base64
import json
import sys

import cv2


def fmt(sec):
    s = int(round(max(0.0, sec)))
    return "%d:%02d" % (s // 60, s % 60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--max-side", type=int, default=896)
    ap.add_argument("--quality", type=int, default=80)
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.file)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "cannot open"}))
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration = total / fps if fps else 0

    frames = []
    n = max(1, args.frames)
    for i in range(n):
        t = duration * (i + 0.5) / n
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, img = cap.read()
        if not ok:
            continue
        h, w = img.shape[:2]
        scale = min(1.0, args.max_side / float(max(w, h)))
        if scale < 1.0:
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), args.quality])
        if not ok:
            continue
        frames.append({"t": fmt(t), "b64": base64.b64encode(buf.tobytes()).decode("ascii")})
    cap.release()

    print(json.dumps({
        "ok": bool(frames),
        "duration": fmt(duration),
        "fps": round(fps, 2),
        "frames": frames,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
