import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Check, Grid3x3, Images, RefreshCcw, Timer, Trash2, X, Zap, ZapOff } from 'lucide-react';
import { useFocusTrap } from '../../hooks/ui/useFocusTrap';
import { useLibraryStore } from '../../store/library.ts';
import { MAX_COMPOSER_FILES, useComposerFilesStore } from '../../store/composerFiles.ts';
import { cn } from '../../utils/ui/cn';
import {
  abilitiesOf,
  applyAdvanced,
  cameraErrorMessage,
  openStream,
  stopStream,
  takePendingStream,
  type CameraAbilities,
  type Facing,
} from './cameraStream.ts';
import { clampZoom, enhanceDocument, frameAspect, pinchDistance, viewfinderCrop } from './cameraMath.ts';

type Phase = 'starting' | 'live' | 'switching' | 'error';
type Mode = 'photo' | 'document';

interface Shot {
  id: string;
  blob: Blob;
  url: string;
  mode: Mode;
}

/** Digital zoom limit when the camera has no zoom of its own. */
const DIGITAL_ZOOM_MAX = 3;
/** Long edge of a saved photo: plenty for reading, light to send. */
const PHOTO_EDGE = 2400;
const NO_ABILITIES: CameraAbilities = { torch: false, zoom: null };

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** The zoom chip that owns the current zoom: the highest stop at or below it. */
function activeStop(zoom: number, stops: number[]): number {
  return stops.filter((stop) => zoom >= stop - 0.05).pop() ?? stops[0];
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Resolves on the first real frame, so the viewfinder never shows black between cameras. */
function firstFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    const withFrames = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (withFrames.requestVideoFrameCallback) {
      withFrames.requestVideoFrameCallback(done);
    } else {
      video.addEventListener('playing', done, { once: true });
    }
    window.setTimeout(done, 1500); // never hang on a camera that is slow to report
  });
}

/**
 * MindPal's camera. A framed viewfinder (3:4 on a phone), front and back with a
 * smooth switch, a tray for several photos, Document mode for pages and notes,
 * flash (the torch, or the screen for selfies), zoom, a timer and a grid. The
 * stream was requested in the tap that opened it (cameraStream.ts).
 */
export const CameraSheet: React.FC = () => {
  const open = useLibraryStore((state) => state.cameraOpen);
  const setOpen = useLibraryStore((state) => state.setCameraOpen);
  const add = useComposerFilesStore((state) => state.add);
  const inComposer = useComposerFilesStore((state) => state.items.length);
  const capacity = Math.max(1, MAX_COMPOSER_FILES - inComposer);

  const videoRef = useRef<HTMLVideoElement>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const trayRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const openRef = useRef(false);
  const galleryRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null);
  const lastTap = useRef(0);
  const generation = useRef(0);

  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [facing, setFacing] = useState<Facing>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [abilities, setAbilities] = useState<CameraAbilities>(NO_ABILITIES);
  const [mode, setMode] = useState<Mode>('photo');
  const [flashOn, setFlashOn] = useState(false);
  const [gridOn, setGridOn] = useState(false);
  const [timerOn, setTimerOn] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [shots, setShots] = useState<Shot[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [flying, setFlying] = useState<{ url: string; dx: number; dy: number } | null>(null);
  const [shutterFlash, setShutterFlash] = useState(false);
  const [screenFlash, setScreenFlash] = useState(false);
  const [notice, setNotice] = useState('');
  const [aspect, setAspect] = useState(() => (typeof window === 'undefined' ? 3 / 4 : frameAspect(window.innerWidth, window.innerHeight)));

  openRef.current = open;
  const zoomMax = abilities.zoom ? Math.min(abilities.zoom.max / Math.max(abilities.zoom.min, 1), 5) : DIGITAL_ZOOM_MAX;
  const nativeZoom = Boolean(abilities.zoom);

  /** Freeze the current frame (blurred) so a switch never flashes black. */
  const freezeFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = freezeRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = Math.min(480, video.videoWidth);
    canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
  }, []);

  const begin = useCallback(async (side: Facing, pending?: Promise<MediaStream> | null) => {
    const mine = ++generation.current;
    // One camera at a time: iOS cannot open the second while the first runs.
    stopStream(streamRef.current);
    streamRef.current = null;
    try {
      const stream = await (pending ?? openStream(side));
      if (mine !== generation.current || !openRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      await firstFrame(video);
      if (mine !== generation.current) return;
      setAbilities(abilitiesOf(stream));
      setZoom(1);
      setPhase('live');
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
    } catch (err) {
      if (mine !== generation.current) return;
      setError(cameraErrorMessage(err));
      setPhase('error');
    }
  }, []);

  const discardShots = useCallback((list: Shot[]) => list.forEach((shot) => URL.revokeObjectURL(shot.url)), []);

  const close = useCallback(() => {
    generation.current += 1;
    stopStream(streamRef.current);
    streamRef.current = null;
    setShots((current) => {
      discardShots(current);
      return [];
    });
    setReviewId(null);
    setPhase('starting');
    setError('');
    setCountdown(null);
    setFlashOn(false);
    setOpen(false);
  }, [discardShots, setOpen]);

  // Tab stays inside; Escape closes.
  const panelRef = useFocusTrap<HTMLDivElement>({ isOpen: open, onClose: close });

  useEffect(() => {
    if (!open) return;
    setFacing('environment');
    setMode('photo');
    setPhase('starting');
    void begin('environment', takePendingStream());
  }, [open, begin]);

  // Backgrounding kills the camera on iOS (a black frame on return): let go on
  // hide, start again on show.
  useEffect(() => {
    if (!open) return;
    const onVisibility = () => {
      if (document.hidden) {
        generation.current += 1;
        stopStream(streamRef.current);
        streamRef.current = null;
      } else if (!streamRef.current) {
        setPhase('switching');
        void begin(facing);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, facing, begin]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setAspect(frameAspect(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => () => stopStream(streamRef.current), []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(id);
  }, [notice]);

  const flip = useCallback(() => {
    if (!canFlip || phase === 'switching') return;
    const next: Facing = facing === 'environment' ? 'user' : 'environment';
    freezeFrame();
    setPhase('switching');
    setFacing(next);
    setFlashOn(false);
    void begin(next);
  }, [begin, canFlip, facing, freezeFrame, phase]);

  const toggleFlash = async () => {
    const next = !flashOn;
    setFlashOn(next);
    // The back camera's light stays on while flash is on; the front uses the screen at the shot.
    if (facing === 'environment' && abilities.torch) await applyAdvanced(streamRef.current, { torch: next });
  };

  const setZoomLevel = useCallback(
    (value: number) => {
      const next = clampZoom(value, zoomMax);
      setZoom(next);
      if (nativeZoom && abilities.zoom) {
        void applyAdvanced(streamRef.current, { zoom: Math.min(abilities.zoom.max, abilities.zoom.min * next) });
      }
    },
    [abilities.zoom, nativeZoom, zoomMax],
  );

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const front = facing === 'user';
    if (flashOn && front) {
      // A white screen lights the face, like a phone's front flash.
      setScreenFlash(true);
      await sleep(260);
    }
    const crop = viewfinderCrop(video.videoWidth, video.videoHeight, aspect, nativeZoom ? 1 : zoom);
    const scale = Math.min(1, PHOTO_EDGE / Math.max(crop.sw, crop.sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(crop.sw * scale);
    canvas.height = Math.round(crop.sh * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: mode === 'document' });
    if (!ctx) return;
    if (front) {
      // The front camera previews mirrored; the photo looks the way you saw it.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
    setScreenFlash(false);
    if (mode === 'document') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      enhanceDocument(pixels.data);
      ctx.putImageData(pixels, 0, 0);
    }
    setShutterFlash(true);
    window.setTimeout(() => setShutterFlash(false), 140);
    navigator.vibrate?.(8);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return;
    const shot: Shot = { id: `shot_${Date.now().toString(36)}`, blob, url: URL.createObjectURL(blob), mode };
    setShots((current) => [...current, shot]);
    setNotice(mode === 'document' ? 'Page added' : 'Photo added');
    // The photo flies into the tray.
    const tray = trayRef.current?.getBoundingClientRect();
    if (tray && !prefersReducedMotion()) {
      const dx = tray.left + tray.width / 2 - window.innerWidth / 2;
      const dy = tray.top + tray.height / 2 - window.innerHeight / 2;
      setFlying({ url: shot.url, dx, dy });
      window.setTimeout(() => setFlying(null), 520);
    }
  }, [aspect, facing, flashOn, mode, nativeZoom, zoom]);

  const capture = useCallback(async () => {
    if (phase !== 'live' || countdown !== null) return;
    if (shots.length >= capacity) {
      setNotice(`Up to ${capacity} ${capacity === 1 ? 'photo' : 'photos'} per message`);
      return;
    }
    if (timerOn) {
      for (let n = 3; n > 0; n -= 1) {
        setCountdown(n);
        await sleep(1000);
        if (!openRef.current) return;
      }
      setCountdown(null);
    }
    await shoot();
  }, [capacity, countdown, phase, shoot, shots.length, timerOn]);

  // Keyboard: Space takes the photo, F flips.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void capture();
      } else if (event.key === 'f' || event.key === 'F') {
        flip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, capture, flip]);

  const finish = () => {
    if (!shots.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    add(
      shots.map(
        (shot, index) =>
          new File([shot.blob], `${shot.mode === 'document' ? 'Page' : 'Photo'} ${stamp}${shots.length > 1 ? ` (${index + 1})` : ''}.jpg`, {
            type: 'image/jpeg',
          }),
      ),
    );
    close();
  };

  const removeShot = (id: string) => {
    setShots((current) => {
      const gone = current.find((shot) => shot.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      const rest = current.filter((shot) => shot.id !== id);
      setReviewId(rest.length ? rest[rest.length - 1].id : null);
      return rest;
    });
  };

  const fromFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    add(files);
    close();
  };

  // Viewfinder gestures: pinch to zoom, double-tap to switch camera.
  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { distance: pinchDistance(a, b), zoom };
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      setZoomLevel(pinchStart.current.zoom * (pinchDistance(a, b) / Math.max(1, pinchStart.current.distance)));
    }
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const wasPinch = pointers.current.size > 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (wasPinch) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      flip();
    } else {
      lastTap.current = now;
    }
  };

  if (!open) return null;

  const front = facing === 'user';
  const showFlash = front || abilities.torch;
  const zoomStops = [1, 2, ...(zoomMax >= 3 ? [3] : [])];
  const reviewing = shots.find((shot) => shot.id === reviewId) ?? null;
  const last = shots[shots.length - 1];
  const addLabel = `Add ${shots.length} ${shots.length === 1 ? 'photo' : 'photos'}`;

  return createPortal(
    <div
      className={cn('camera-sheet', front && 'camera-sheet--front', screenFlash && 'camera-sheet--screen-flash')}
      role="dialog"
      aria-modal="true"
      aria-label="Camera"
      ref={panelRef}
    >
      <div className="camera-sheet__top">
        <button type="button" className="camera-sheet__icon" onClick={close} aria-label="Close camera">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="camera-sheet__tools">
          <button
            type="button"
            className={cn('camera-sheet__icon', timerOn && 'is-on')}
            onClick={() => setTimerOn((on) => !on)}
            aria-label={timerOn ? 'Timer: 3 seconds' : 'Timer: off'}
            aria-pressed={timerOn}
          >
            <Timer className="h-5 w-5" aria-hidden="true" />
            {timerOn ? <span className="camera-sheet__badge">3s</span> : null}
          </button>
          <button
            type="button"
            className={cn('camera-sheet__icon', gridOn && 'is-on')}
            onClick={() => setGridOn((on) => !on)}
            aria-label={gridOn ? 'Hide grid' : 'Show grid'}
            aria-pressed={gridOn}
          >
            <Grid3x3 className="h-5 w-5" aria-hidden="true" />
          </button>
          {showFlash ? (
            <button
              type="button"
              className={cn('camera-sheet__icon', flashOn && 'is-on')}
              onClick={() => void toggleFlash()}
              aria-label={flashOn ? 'Flash on' : 'Flash off'}
              aria-pressed={flashOn}
            >
              {flashOn ? <Zap className="h-5 w-5" aria-hidden="true" /> : <ZapOff className="h-5 w-5" aria-hidden="true" />}
            </button>
          ) : null}
          {shots.length ? (
            <button type="button" className="camera-sheet__done" onClick={finish} aria-label={addLabel}>
              <Check className="h-4 w-4" aria-hidden="true" />
              Add {shots.length}
            </button>
          ) : null}
        </div>
      </div>

      <div className="camera-sheet__middle">
        <div
          className={cn('camera-sheet__frame', phase === 'switching' && 'is-switching', mode === 'document' && 'is-document')}
          style={{ aspectRatio: String(aspect) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <video
            ref={videoRef}
            className={cn('camera-sheet__video', phase === 'live' && 'is-live')}
            style={{ transform: `${front ? 'scaleX(-1) ' : ''}scale(${nativeZoom ? 1 : zoom})` }}
            playsInline
            muted
            autoPlay
          />
          <canvas
            ref={freezeRef}
            className={cn('camera-sheet__freeze', front && 'is-mirrored', phase === 'switching' && 'is-on')}
            aria-hidden="true"
          />
          {gridOn ? <div className="camera-sheet__grid" aria-hidden="true" /> : null}
          {mode === 'document' ? (
            <div className="camera-sheet__guide" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {mode === 'document' && phase === 'live' && !notice ? <p className="camera-sheet__hint">Fill the frame with the page</p> : null}
          {/* Always mounted, so it fades out as the picture fades in rather than vanishing. */}
          <div className={cn('camera-sheet__starting', phase !== 'starting' && 'is-gone')} aria-hidden={phase !== 'starting'}>
            <span className="camera-sheet__starting-ring" />
            <span className="camera-sheet__starting-text">Starting the camera…</span>
          </div>
          {phase === 'error' ? (
            <div className="camera-sheet__status camera-sheet__status--error" role="alert">
              <Camera className="h-8 w-8 opacity-80" aria-hidden="true" />
              <p>{error}</p>
              <button type="button" className="camera-sheet__pill" onClick={() => captureRef.current?.click()}>
                Use the camera app
              </button>
            </div>
          ) : null}
          {countdown !== null ? (
            <div className="camera-sheet__countdown" key={countdown} aria-live="assertive">
              {countdown}
            </div>
          ) : null}
          {phase === 'live' ? (
            <div className="camera-sheet__zoom" role="group" aria-label="Zoom">
              {zoomStops.map((stop) => (
                <button
                  key={stop}
                  type="button"
                  className={cn('camera-sheet__zoom-stop', Math.abs(zoom - stop) < 0.15 && 'is-on')}
                  onClick={() => setZoomLevel(stop)}
                  aria-label={`Zoom ${stop}x`}
                  aria-pressed={Math.abs(zoom - stop) < 0.15}
                >
                  {activeStop(zoom, zoomStops) === stop && Math.abs(zoom - stop) >= 0.05 ? `${zoom.toFixed(1)}×` : `${stop}×`}
                </button>
              ))}
            </div>
          ) : null}
          <div className={cn('camera-sheet__shutter-flash', shutterFlash && 'is-on')} aria-hidden="true" />
        </div>
      </div>

      <div className="camera-sheet__bottom">
        <div className="camera-sheet__modes" role="radiogroup" aria-label="Mode">
          {(['photo', 'document'] as Mode[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={cn('camera-sheet__mode', mode === value && 'is-on')}
              onClick={() => setMode(value)}
            >
              {value === 'photo' ? 'Photo' : 'Document'}
            </button>
          ))}
        </div>
        <div className="camera-sheet__controls">
          {last ? (
            <button
              ref={trayRef}
              type="button"
              className="camera-sheet__tray"
              onClick={() => setReviewId(last.id)}
              aria-label={`Review ${shots.length} ${shots.length === 1 ? 'photo' : 'photos'}`}
            >
              <img src={last.url} alt="" />
              <span className="camera-sheet__count">{shots.length}</span>
            </button>
          ) : (
            <button
              ref={trayRef}
              type="button"
              className="camera-sheet__icon camera-sheet__icon--large"
              onClick={() => galleryRef.current?.click()}
              aria-label="Choose from your photos"
            >
              <Images className="h-6 w-6" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={cn('camera-sheet__shutter', mode === 'document' && 'is-document')}
            onClick={() => void capture()}
            disabled={phase !== 'live' || countdown !== null}
            aria-label="Take photo"
          >
            <span />
          </button>
          <button
            type="button"
            className={cn('camera-sheet__icon camera-sheet__icon--large camera-sheet__flip', phase === 'switching' && 'is-turning')}
            onClick={flip}
            disabled={!canFlip || phase === 'error'}
            aria-label="Switch camera"
          >
            <RefreshCcw className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>
      </div>

      {flying ? (
        <img
          src={flying.url}
          alt=""
          className="camera-sheet__flying"
          style={{ '--fly-x': `${flying.dx}px`, '--fly-y': `${flying.dy}px` } as React.CSSProperties}
        />
      ) : null}

      {reviewing ? (
        <div className="camera-sheet__review" role="dialog" aria-label="Your photos">
          <div className="camera-sheet__review-top">
            <button type="button" className="camera-sheet__pill" onClick={() => setReviewId(null)}>
              Keep shooting
            </button>
            <button type="button" className="camera-sheet__done" onClick={finish} aria-label={addLabel}>
              <Check className="h-4 w-4" aria-hidden="true" />
              Add {shots.length}
            </button>
          </div>
          <img src={reviewing.url} alt="Selected photo" className="camera-sheet__review-image" />
          <div className="camera-sheet__review-strip">
            {shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                className={cn('camera-sheet__review-thumb', shot.id === reviewing.id && 'is-on')}
                onClick={() => setReviewId(shot.id)}
                aria-label="Show this photo"
                aria-pressed={shot.id === reviewing.id}
              >
                <img src={shot.url} alt="" />
              </button>
            ))}
            <button type="button" className="camera-sheet__icon camera-sheet__delete" onClick={() => removeShot(reviewing.id)} aria-label="Delete this photo">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="camera-sheet__screen-flash" aria-hidden="true" />
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>
      {notice ? <div className="camera-sheet__notice">{notice}</div> : null}
      <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={fromFiles} />
      <input ref={captureRef} type="file" accept="image/*" capture="environment" hidden onChange={fromFiles} />
    </div>,
    document.body,
  );
};
