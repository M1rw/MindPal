import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Check, RefreshCcw, RotateCcw, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/ui/useFocusTrap';
import { useLibraryStore } from '../../store/library.ts';
import { useComposerFilesStore } from '../../store/composerFiles.ts';
import { cn } from '../../utils/ui/cn';
import { cameraErrorMessage, openStream, stopStream, takePendingStream, type Facing } from './cameraStream.ts';

type Phase = 'starting' | 'live' | 'review' | 'error';

/**
 * MindPal's camera: a viewfinder, a shutter, front/back, then retake or use.
 * The stream was requested in the tap that opened this (see cameraStream.ts).
 */
export const CameraSheet: React.FC = () => {
  const open = useLibraryStore((state) => state.cameraOpen);
  const setOpen = useLibraryStore((state) => state.setCameraOpen);
  const add = useComposerFilesStore((state) => state.add);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [facing, setFacing] = useState<Facing>('environment');
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [flash, setFlash] = useState(false);
  const [canFlip, setCanFlip] = useState(false);

  const attach = useCallback(async (stream: MediaStream) => {
    stopStream(streamRef.current);
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay can be refused until the element is visible; the next frame starts it */
    }
    setPhase('live');
  }, []);

  const start = useCallback(
    async (side: Facing, pending?: Promise<MediaStream> | null) => {
      setPhase('starting');
      try {
        await attach(await (pending ?? openStream(side)));
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch (err) {
        setError(cameraErrorMessage(err));
        setPhase('error');
      }
    },
    [attach],
  );

  const close = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setPhase('starting');
    setError('');
    setOpen(false);
  }, [setOpen, shot]);

  // Tab stays inside; Escape closes.
  const panelRef = useFocusTrap<HTMLDivElement>({ isOpen: open, onClose: close });

  useEffect(() => {
    if (!open) return;
    setFacing('environment');
    void start('environment', takePendingStream());
  }, [open, start]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const snap = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facing === 'user') {
      // The front camera previews mirrored; the photo should look the same.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 180);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setShot({ blob, url: URL.createObjectURL(blob) });
        setPhase('review');
      },
      'image/jpeg',
      0.92,
    );
  };

  const flip = () => {
    const next: Facing = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    void start(next);
  };

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setPhase('live');
  };

  const use = () => {
    if (!shot) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    add([new File([shot.blob], `Photo ${stamp}.jpg`, { type: 'image/jpeg' })]);
    close();
  };

  const nativeCamera = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) add(files);
    close();
  };

  if (!open) return null;
  return createPortal(
    <div className="camera-sheet" role="dialog" aria-modal="true" aria-label="Camera" ref={panelRef}>
      <div className="camera-sheet__stage">
        <video
          ref={videoRef}
          className={cn('camera-sheet__video', facing === 'user' && 'camera-sheet__video--mirror', phase === 'review' && 'is-hidden')}
          playsInline
          muted
          autoPlay
        />
        {shot && phase === 'review' ? <img src={shot.url} alt="The photo you took" className="camera-sheet__shot" /> : null}
        {phase === 'starting' ? <div className="camera-sheet__status">Starting the camera…</div> : null}
        {phase === 'error' ? (
          <div className="camera-sheet__status camera-sheet__status--error" role="alert">
            <Camera className="h-8 w-8 opacity-80" aria-hidden="true" />
            <p>{error}</p>
            <button type="button" className="camera-sheet__pill" onClick={() => captureRef.current?.click()}>
              Use the camera app
            </button>
          </div>
        ) : null}
        <div className={cn('camera-sheet__flash', flash && 'is-on')} aria-hidden="true" />
      </div>

      <button type="button" className="camera-sheet__close" onClick={close} aria-label="Close camera">
        <X className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="camera-sheet__bar">
        {phase === 'review' ? (
          <>
            <button type="button" className="camera-sheet__pill" onClick={retake}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Retake
            </button>
            <button type="button" className="camera-sheet__pill camera-sheet__pill--primary" onClick={use} autoFocus>
              <Check className="h-4 w-4" aria-hidden="true" /> Use photo
            </button>
          </>
        ) : (
          <>
            <span className="camera-sheet__spacer" />
            <button
              type="button"
              className="camera-sheet__shutter"
              onClick={snap}
              disabled={phase !== 'live'}
              aria-label="Take photo"
            >
              <span />
            </button>
            {canFlip ? (
              <button type="button" className="camera-sheet__flip" onClick={flip} aria-label="Switch camera">
                <RefreshCcw className="h-5 w-5" aria-hidden="true" />
              </button>
            ) : (
              <span className="camera-sheet__spacer" />
            )}
          </>
        )}
      </div>
      <input ref={captureRef} type="file" accept="image/*" capture="environment" hidden onChange={nativeCamera} />
    </div>,
    document.body,
  );
};
