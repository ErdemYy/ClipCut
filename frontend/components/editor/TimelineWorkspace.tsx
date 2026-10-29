"use client";

import { useCallback } from "react";
import { api, type Project, type TimelineInfo } from "@/lib/api";
import { checkedTimeline, sourceReadKey, timelineReadKey } from "@/lib/media-reads";
import { useReadResource } from "@/lib/use-read-resource";
import ReadResourceStatus from "./ReadResourceStatus";
import SourceWaveform from "./SourceWaveform";
import Timeline from "./Timeline";
import styles from "./timeline.module.css";

type Props = { project: Project; time: number; onSeek: (time: number) => void;
  setProject: (project: Project) => void; notify: (text: string, error?: boolean) => void };

export default function TimelineWorkspace({ project, ...props }: Props) {
  const { id, duration, timeline_revision: revision } = project;
  const sourceKey = sourceReadKey(project);
  const key = timelineReadKey(project);
  const read = useCallback(async (signal: AbortSignal) => checkedTimeline(await api.timeline(id, signal), duration, revision), [id, duration, revision]);
  const state = useReadResource(key, sourceKey, read, { enabled: project.status === "ready", delayMs: 250 });
  const { publish } = state;
  const accept = useCallback((value: TimelineInfo) => {
    try { return publish(checkedTimeline(value, duration, revision)); }
    catch { return false; }
  }, [publish, duration, revision]);

  return <div className={styles.readStack}>
    <ReadResourceStatus id="timeline-read" label="Zaman çizelgesi" state={state} />
    <SourceWaveform project={project} />
    {state.data && <Timeline key={sourceKey} project={project} {...props} timeline={state.data}
      readOnly={!state.current || state.pending || !!state.error} onTimeline={accept} />}
  </div>;
}
