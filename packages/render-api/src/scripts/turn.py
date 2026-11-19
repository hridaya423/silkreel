import sys, glob, json, os, numpy as np, soundfile as sf
from scipy import signal
sr = 48000
def kw(x):
    b, a = signal.butter(2, 100 / (sr / 2), 'high'); y = signal.lfilter(b, a, x, axis=0)
    b, a = signal.iirfilter(1, 1500 / (sr / 2), btype='high', ftype='butter'); return y + 0.58 * signal.lfilter(b, a, y, axis=0)
for f in sorted(glob.glob(f'{sys.argv[1]}/*/*.wav')):
    x, _ = sf.read(f); y = kw(x)
    w = int(0.4 * sr); hop = int(0.1 * sr)
    t = np.arange(0, len(y) - w, hop) / sr
    mom = np.array([10 * np.log10(np.mean(y[int(s * sr):int(s * sr) + w] ** 2, axis=0).sum() + 1e-12) - 0.691 for s in t])
    cues = json.load(open(f[:-4] + '.cues.json'))['cues']
    style = f.split('/')[-2]
    if style == 'trace': turn = [c['t'] for c in cues if c['kind'] == 'wake']
    elif style == 'montage': turn = [c['t'] for c in cues if c['kind'] == 'hit']
    else: turn = [c['t'] for c in cues if c['kind'] == 'paper:tilt']
    end = ([c['t'] for c in cues if c['kind'] == 'stood'] or [turn[0] if turn else 0])[0] + 0.6 if style == 'blueprint' else (turn[0] + 0.9 if turn else 0)
    if not turn: print(f, 'no turn'); continue
    T = turn[0]
    near = (t + 0.2 >= T - 0.3) & (t + 0.2 <= end)
    at = mom[near].max(); other = mom[~near].max(); where = t[~near][np.argmax(mom[~near])] + 0.2
    print(f"{style[:5]} {os.path.basename(f)[:-4]:16s} turn {T:5.2f}s {at:6.1f}  loudest elsewhere {other:6.1f} at {where:5.1f}s  margin {at-other:+5.1f} LU")
