import React, { useEffect, useState } from 'react';
import { formatBytes } from '../../shared/utils/format';
import type {
  ComposeInventoryProject,
  ComposeInventorySnapshot,
} from '../../shared/types/composeInventory';
import type { HostResourceSnapshot, ResourceBucketId } from '../../shared/types/hostResources';
import './resources.css';

const POLL_MS = 1_000;

const BUCKET_LABELS: Record<ResourceBucketId, string> = {
  app: 'Boundary app',
  stack: 'Assistant stack',
  llm: 'Local LLM',
  rest: 'Rest of computer',
};

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function bytesLabel(value: number | null): string {
  if (value == null) return '—';
  return formatBytes(value);
}

function attributedShare(snapshot: HostResourceSnapshot): number {
  const { app, stack, llm } = snapshot.buckets;
  return app.cpuShare + stack.cpuShare + llm.cpuShare;
}

function attributedMemory(snapshot: HostResourceSnapshot): number {
  const { app, stack, llm } = snapshot.buckets;
  return app.memoryBytes + stack.memoryBytes + llm.memoryBytes;
}

function attributedDisk(snapshot: HostResourceSnapshot): number | null {
  const { app, stack, llm } = snapshot.buckets;
  if (app.diskBytes == null || stack.diskBytes == null || llm.diskBytes == null) {
    return null;
  }
  return app.diskBytes + stack.diskBytes + llm.diskBytes;
}

function barWidth(share: number | null, fallback = 0): string {
  const value = share == null ? fallback : Math.max(0, share) * 100;
  return `${value}%`;
}

function shareOf(part: number | null, total: number): number | null {
  if (part == null || total <= 0) return null;
  return part / total;
}

function displayPath(value: string): string {
  return value.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function serviceCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'service' : 'services'}`;
}

export const ComposeInventoryView: React.FC<{
  inventory: ComposeInventorySnapshot | null;
}> = ({ inventory }) => {
  return (
    <div className="wb-resources-inventory" aria-label="Compose on this machine">
      <h2>Compose on this machine</h2>
      <p className="wb-resources-inventory-sub">
        Observe only. Services still starts Boundary’s stack.
      </p>
      {!inventory ? (
        <p className="wb-resources-inventory-honesty">Reading Compose projects…</p>
      ) : !inventory.engineRunning ? (
        <p className="wb-resources-inventory-honesty">
          Engine is not running. Host Compose projects cannot be listed until Docker or Podman is
          up.
        </p>
      ) : inventory.projects.length === 0 ? (
        <p className="wb-resources-inventory-honesty">
          No Compose projects on this host. Projects appear here when the engine has labeled
          containers.
        </p>
      ) : (
        <div>
          {inventory.projects.map((project) => (
            <ComposeProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
};

const ComposeProjectRow: React.FC<{ project: ComposeInventoryProject }> = ({ project }) => {
  return (
    <details className="wb-resources-project">
      <summary>
        <div className="name">
          {project.name}
          <span>{displayPath(project.path)}</span>
        </div>
        <span className={`status ${project.status}`}>{project.status}</span>
        <span className="meta mono">{serviceCountLabel(project.services.length)}</span>
      </summary>
      {project.services.length > 0 ? (
        <div className="wb-resources-services">
          {project.services.map((service) => (
            <div className="wb-resources-service" key={service.name}>
              <span>{service.name}</span>
              <span className="ports mono">
                {service.ports.length > 0 ? service.ports.join(' · ') : 'no ports'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
};

export const ResourcesView: React.FC<{
  snapshot: HostResourceSnapshot | null;
  error: string | null;
  inventory?: ComposeInventorySnapshot | null;
}> = ({ snapshot, error, inventory = null }) => {
  if (error) {
    return (
      <section className="wb-resources" aria-label="Resources">
        <h1>Resources</h1>
        <p className="wb-resources-error">{error}</p>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="wb-resources" aria-label="Resources">
        <h1>Resources</h1>
        <p className="wb-resources-host">Reading this machine…</p>
      </section>
    );
  }

  const diskReady = attributedDisk(snapshot) != null;
  const caveat = snapshot.caveats.join(' ');

  return (
    <section className="wb-resources" aria-label="Resources">
      <div className="wb-resources-machine">
        <div>
          <h1>Resources</h1>
          <div className="wb-resources-host mono">
            {snapshot.host.displayName} · updated just now
          </div>
        </div>
        <div className="wb-resources-facts">
          <div>
            <b>{snapshot.host.cpuCores}</b>cores
          </div>
          <div>
            <b>{formatBytes(snapshot.host.memoryBytes)}</b>memory
          </div>
          <div>
            <b>{formatBytes(snapshot.host.diskBytes)}</b>disk
          </div>
        </div>
      </div>

      <div className="wb-resources-meters">
        <div>
          <div className="wb-resources-meter-head">
            <span className="name">CPU</span>
            <span className="readout mono">
              {pct(attributedShare(snapshot))} attributed · {snapshot.host.cpuCores} cores
            </span>
          </div>
          <div className="wb-resources-bar" aria-label="CPU share of host">
            <i className="app" style={{ width: barWidth(snapshot.buckets.app.cpuShare) }} />
            <i className="stack" style={{ width: barWidth(snapshot.buckets.stack.cpuShare) }} />
            <i className="llm" style={{ width: barWidth(snapshot.buckets.llm.cpuShare) }} />
            <i className="rest" style={{ width: barWidth(snapshot.buckets.rest.cpuShare) }} />
          </div>
        </div>
        <div>
          <div className="wb-resources-meter-head">
            <span className="name">Memory</span>
            <span className="readout mono">
              {formatBytes(attributedMemory(snapshot))} attributed ·{' '}
              {formatBytes(snapshot.host.memoryBytes)}
            </span>
          </div>
          <div className="wb-resources-bar" aria-label="Memory share of host">
            <i className="app" style={{ width: barWidth(shareOf(snapshot.buckets.app.memoryBytes, snapshot.host.memoryBytes)) }} />
            <i className="stack" style={{ width: barWidth(shareOf(snapshot.buckets.stack.memoryBytes, snapshot.host.memoryBytes)) }} />
            <i className="llm" style={{ width: barWidth(shareOf(snapshot.buckets.llm.memoryBytes, snapshot.host.memoryBytes)) }} />
            <i className="rest" style={{ width: barWidth(shareOf(snapshot.buckets.rest.memoryBytes, snapshot.host.memoryBytes)) }} />
          </div>
        </div>
        <div>
          <div className="wb-resources-meter-head">
            <span className="name">Disk</span>
            <span className="readout mono">
              {diskReady
                ? `${bytesLabel(attributedDisk(snapshot))} attributed · ${formatBytes(snapshot.host.diskBytes)}`
                : 'Measuring…'}
            </span>
          </div>
          <div className="wb-resources-bar" aria-label="Disk capacity share">
            <i className="app" style={{ width: barWidth(shareOf(snapshot.buckets.app.diskBytes, snapshot.host.diskBytes)) }} />
            <i className="stack" style={{ width: barWidth(shareOf(snapshot.buckets.stack.diskBytes, snapshot.host.diskBytes)) }} />
            <i className="llm" style={{ width: barWidth(shareOf(snapshot.buckets.llm.diskBytes, snapshot.host.diskBytes)) }} />
            <i
              className="rest"
              style={{
                width: barWidth(
                  shareOf(snapshot.buckets.rest.diskBytes, snapshot.host.diskBytes),
                  diskReady ? 0 : 1
                ),
              }}
            />
          </div>
        </div>
      </div>

      <div className="wb-resources-legend">
        <span>
          <i className="app" />
          Boundary app
        </span>
        <span>
          <i className="stack" />
          Assistant stack
        </span>
        <span>
          <i className="llm" />
          Local LLM
        </span>
        <span>
          <i className="rest" />
          Rest of computer <em>(estimated)</em>
        </span>
      </div>

      <div className="wb-resources-rows">
        {(['app', 'stack', 'llm', 'rest'] as const).map((id) => {
          const bucket = snapshot.buckets[id];
          return (
            <div className="wb-resources-row" key={id}>
              <div className="who">
                {BUCKET_LABELS[id]}
                <span>{bucket.detail}</span>
              </div>
              <div className="n mono">{pct(bucket.cpuShare)}</div>
              <div className="n mono">{bytesLabel(bucket.memoryBytes)}</div>
              <div className="n mono">{bytesLabel(bucket.diskBytes)}</div>
            </div>
          );
        })}
      </div>

      <p className="wb-resources-caveat">{caveat}</p>
      <ComposeInventoryView inventory={inventory} />
    </section>
  );
};

export const ResourcesScreen: React.FC = () => {
  const [snapshot, setSnapshot] = useState<HostResourceSnapshot | null>(null);
  const [inventory, setInventory] = useState<ComposeInventorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A sample can take longer than POLL_MS; skip ticks until the last one returns.
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await window.electronAPI.resources.getSnapshot();
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: ComposeInventorySnapshot) => {
      if (!cancelled) setInventory(next);
    };
    void window.electronAPI.resources.getComposeInventory().then(apply).catch(() => {
      if (!cancelled) {
        setInventory({ engineRunning: false, projects: [] });
      }
    });
    const unsubscribe = window.electronAPI.resources.subscribeComposeInventory(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return <ResourcesView snapshot={snapshot} error={error} inventory={inventory} />;
};
