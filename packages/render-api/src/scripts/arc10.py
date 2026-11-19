import glob, os, subprocess, sys, json, tempfile
import numpy as np
from scipy import signal

sr = 48000
root = sys.argv[1]
aac = '--aac' in sys.argv


def load(f):
    if aac and f.endswith('.wav'):
        with tempfile.TemporaryDirectory() as d:
            m = os.path.join(d, 'a.m4a')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f, '-c:a', 'aac', '-b:a', '256k', m], check=True)
            f = m
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'], capture_output=True).stdout
    else:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def db(x): return 10 * np.log10(max(x, 1e-12))


def kw(x):
    b, a = signal.butter(2, 100 / (sr / 2), 'high'); y = signal.lfilter(b, a, x, axis=0)
    b, a = signal.iirfilter(1, 1500 / (sr / 2), btype='high', ftype='butter'); return y + 0.58 * signal.lfilter(b, a, y, axis=0)


def lk(x):
    y = kw(x); return -0.691 + db(np.mean(y ** 2, axis=0).sum())


def tp(x):
    up = signal.resample_poly(x, 4, 1, axis=0)
    return 20 * np.log10(np.abs(up).max())


def lra(x):
    w = int(3 * sr); hop = int(0.1 * sr); y = kw(x)
    st = np.array([db(np.mean(y[i:i + w] ** 2, axis=0).sum()) - 0.691 for i in range(0, len(y) - w, hop)])
    st = st[st > -70]
    rel = st[st > 10 * np.log10(np.mean(10 ** (st / 10))) - 20]
    return np.percentile(rel, 95) - np.percentile(rel, 10)


print(f"{'film':24s} {'TP':>6s} {'phone':>6s} {'mono':>5s} {'corr':>5s} {'S/M':>6s} {'<150':>5s} {'1-8k':>5s} {'bright':>6s} {'max@':>5s} {'max':>6s} {'1st':>6s} {'body':>6s} {'1st-b':>5s} {'last50':>6s} {'last.3':>6s} {'LRA':>4s} {'I':>6s}")
for style in ['trace', 'blueprint', 'montage']:
    for f in sorted(glob.glob(f'{root}/{style}/*.wav') + glob.glob(f'{root}/{style}/*.mp4')):
        x = load(f); name = os.path.basename(f).rsplit('.', 1)[0]
        full = lk(x)
        mono = x.mean(axis=1, keepdims=True); mono2 = np.repeat(mono, 2, axis=1)
        b, a = signal.butter(2, 300 / (sr / 2), 'high'); ph = signal.lfilter(b, a, mono2, axis=0)
        spec = np.abs(np.fft.rfft(mono[:, 0])) ** 2; fr = np.fft.rfftfreq(len(mono), 1 / sr); tot = spec.sum()
        sh = lambda lo, hi: 100 * spec[(fr >= lo) & (fr < hi)].sum() / tot
        w = int(0.4 * sr); hop = int(0.1 * sr); y = kw(x)
        mom = np.array([db(np.mean(y[i:i + w] ** 2, axis=0).sum()) - 0.691 for i in range(0, len(y) - w, hop)])
        tmax = np.argmax(mom) * 0.1 + 0.2
        corr = np.corrcoef(x[:, 0], x[:, 1])[0, 1]
        m = (x[:, 0] + x[:, 1]) / 2; s = (x[:, 0] - x[:, 1]) / 2
        sm = db(np.mean(s ** 2)) - db(np.mean(m ** 2))
        fs, t, S = signal.stft(mono[:, 0], sr, nperseg=2048)
        P = np.abs(S) ** 2; e = P.sum(axis=0); cen = (fs[:, None] * P).sum(axis=0) / np.maximum(e, 1e-20)
        bright = np.median(cen[e > np.percentile(e, 20)])
        first = lk(x[:sr]); body = lk(x[2 * sr:9 * sr])
        last50 = db(np.mean(x[-int(0.05 * sr):] ** 2) * 2); last3 = db(np.mean(x[-int(0.3 * sr):] ** 2) * 2)
        print(f"{style[:5]+' '+name:24s} {tp(x):6.1f} {lk(ph)-full:6.1f} {lk(mono2)-full:5.1f} {corr:5.2f} {sm:6.1f} {sh(0,150):5.1f} {sh(1000,8000):5.1f} {bright:6.0f} {tmax:5.1f} {mom.max():6.1f} {first:6.1f} {body:6.1f} {first-body:5.1f} {last50:6.1f} {last3:6.1f} {lra(x):4.1f} {lk(x):6.1f}")
