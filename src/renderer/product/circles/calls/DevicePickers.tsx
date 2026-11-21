import React, { useEffect, useState } from 'react';
import { Field } from '../../../components/ui/field';
import { NativeSelect } from '../../../components/ui/native-select';

async function listDevices(): Promise<MediaDeviceInfo[]> {
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

/**
 * The microphone and camera pickers. The browser only names devices once access is granted, so
 * render this after asking; the list refreshes when a device is plugged in or removed. `null`
 * means the system default.
 */
export const DevicePickers: React.FC<{
  microphone: string | null;
  camera: string | null;
  onMicrophone: (id: string) => void;
  onCamera: (id: string) => void;
}> = ({ microphone, camera, onMicrophone, onCamera }) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = (): void =>
      void listDevices().then((list): void => {
        if (live) setDevices(list);
      });
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      live = false;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  const picker = (id: string, label: string, kind: MediaDeviceKind, value: string | null, onPick: (id: string) => void) => {
    const options = devices.filter((device) => device.kind === kind && device.deviceId !== 'default');
    return (
      <Field label={label} htmlFor={id}>
        <NativeSelect id={id} value={value ?? ''} onChange={(event) => onPick(event.target.value)}>
          <option value="">System default</option>
          {options.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </option>
          ))}
        </NativeSelect>
      </Field>
    );
  };

  return (
    <div className="wb-fields-inline">
      {picker('join-call-microphone', 'Microphone', 'audioinput', microphone, onMicrophone)}
      {picker('join-call-camera', 'Camera', 'videoinput', camera, onCamera)}
    </div>
  );
};
