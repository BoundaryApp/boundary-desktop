import React, { useEffect, useRef, useState } from 'react';
import type { MediaAccessStatus, MediaDevice } from '../../../../shared/types/media';
import { Sheet } from '../../../components/ui/sheet';
import { watchLevel } from './audioLevel';
import { fallsBackToDefault } from './deviceFallback';
import type { JoinOptions } from './callService';
import { DevicePickers } from './DevicePickers';
import { Button } from '../../../components/ui/button';
import './calls.css';
import { Switch } from '../../../components/ui/switch';

const blocked = (status: MediaAccessStatus) => status === 'denied' || status === 'restricted';

const stopAll = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());

/**
 * One device's stream, or null when it can't be opened. A picked device that is gone falls back to
 * the default, by the same rule the call uses.
 */
async function open(kind: 'audio' | 'video', id: string | null): Promise<MediaStream | null> {
  const media = (constraint: boolean | MediaTrackConstraints) =>
    navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: constraint } : { video: constraint });
  try {
    return await media(id ? { deviceId: { exact: id } } : true);
  } catch (error) {
    if (!id || !fallsBackToDefault(error)) return null;
  }
  try {
    return await media(true);
  } catch {
    return null;
  }
}

const DeniedLine: React.FC<{ device: MediaDevice }> = ({ device }) => (
  <div className="wb-join-denied">
    <p className="wb-sheet-help">
      Boundary can't use the {device}. Turn it on in System Settings › Privacy & Security.
    </p>
    <Button variant="secondary" block type="button" onClick={() => void window.electronAPI.media.openPrivacySettings(device)}>
      Open System Settings
    </Button>
  </div>
);

const Preview: React.FC<{ stream: MediaStream }> = ({ stream }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className="wb-join-preview" autoPlay muted playsInline aria-label="Camera preview" />;
};

/**
 * The sheet before a call: asks for the microphone, shows its level, and offers the camera with
 * a preview and the device pickers. It stops its own streams before `onJoin`, so the call opens
 * the devices fresh.
 */
export const JoinCallSheet: React.FC<{
  title: string;
  onJoin: (options: JoinOptions) => void;
  onCancel: () => void;
}> = ({ title, onJoin, onCancel }) => {
  const [micDenied, setMicDenied] = useState(false);
  const [camDenied, setCamDenied] = useState(false);
  const [ready, setReady] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [microphone, setMicrophone] = useState<string | null>(null);
  const [camera, setCamera] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const streams = useRef<{ audio: MediaStream | null; video: MediaStream | null }>({ audio: null, video: null });

  // Ask for the microphone once; the call will use it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const access = await window.electronAPI.media.getAccess().catch((): null => null);
      const status = access && blocked(access.microphone)
        ? access.microphone
        : await window.electronAPI.media.requestAccess('microphone').catch((): MediaAccessStatus => 'unknown');
      if (!live) return;
      setMicDenied(blocked(status));
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // The meter follows the picked microphone.
  useEffect(() => {
    if (!ready || micDenied) return;
    let live = true;
    let stopWatching = (): void => undefined;
    void open('audio', microphone).then((stream) => {
      if (!stream) return;
      if (!live) {
        stopAll(stream);
        return;
      }
      streams.current.audio = stream;
      stopWatching = watchLevel(stream, setLevel);
    });
    return () => {
      live = false;
      stopWatching();
      stopAll(streams.current.audio);
      streams.current.audio = null;
      setLevel(0);
    };
  }, [ready, micDenied, microphone]);

  // The preview runs while the camera switch is on.
  useEffect(() => {
    if (!cameraOn) return;
    let live = true;
    void (async () => {
      const access = await window.electronAPI.media.getAccess().catch((): null => null);
      const status = access && blocked(access.camera)
        ? access.camera
        : await window.electronAPI.media.requestAccess('camera').catch((): MediaAccessStatus => 'unknown');
      if (!live) return;
      if (blocked(status)) {
        setCamDenied(true);
        setCameraOn(false);
        return;
      }
      setCamDenied(false);
      const stream = await open('video', camera);
      if (!stream) {
        if (live) setCameraOn(false);
        return;
      }
      if (!live) {
        stopAll(stream);
        return;
      }
      streams.current.video = stream;
      setPreview(stream);
    })();
    return () => {
      live = false;
      stopAll(streams.current.video);
      streams.current.video = null;
      setPreview(null);
    };
  }, [cameraOn, camera]);

  const join = () => {
    stopAll(streams.current.audio);
    stopAll(streams.current.video);
    streams.current = { audio: null, video: null };
    onJoin({
      audio: !micDenied,
      video: cameraOn && !camDenied,
      ...(microphone ? { microphone } : {}),
      ...(camera ? { camera } : {}),
    });
  };

  return (
    <Sheet
      open
      onClose={onCancel}
      titleId="join-call-title"
      title={title}
      actions={
        <>
          <Button variant="secondary" block type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" block type="button" disabled={!ready} onClick={join}>
            {micDenied ? 'Join without microphone' : 'Join'}
          </Button>
        </>
      }
    >
      {micDenied ? (
        <DeniedLine device="microphone" />
      ) : (
        <div
          className="wb-join-meter"
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={level}
        >
          <i style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
      )}
      <div className="wb-join-camera">
        <span id="join-call-camera-label">Camera</span>
        <Switch checked={cameraOn} labelledBy="join-call-camera-label" onChange={setCameraOn} />
      </div>
      {camDenied ? <DeniedLine device="camera" /> : null}
      {preview ? <Preview stream={preview} /> : null}
      {ready ? (
        <DevicePickers
          key={`${micDenied}-${cameraOn}`}
          microphone={microphone}
          camera={camera}
          onMicrophone={(id) => setMicrophone(id || null)}
          onCamera={(id) => setCamera(id || null)}
        />
      ) : null}
    </Sheet>
  );
};
