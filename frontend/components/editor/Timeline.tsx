"use client";

import { formatTime, type Project, type TimelineInfo } from "@/lib/api";
import styles from "./editor-parts.module.css";

type Props = { project: Project; timeline: TimelineInfo; time: number; onSeek: (t: number) => void };

export default function Timeline({ project, timeline, time, onSeek }: Props) {
  const total = timeline.source_duration || project.duration || 1;
  const pct = (t: number) => `${(t / total) * 100}%`;
  const segments = project.subtitles?.segments ?? [];
  const texts = (project.plan?.operations ?? []).filter((o) => o.type === "text") as unknown as { text: string; start: number; duration: number }[];
  const music = project.plan?.operations.find((o) => o.type === "music");
  const removed = total - timeline.segments.reduce((a, [s, e]) => a + (e - s), 0);

  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left - 64) / (rect.width - 64);
    if (x >= 0) onSeek(Math.min(1, x) * total);
  };

  return (
    <div className={`${styles.timeline} glass`}>
      <div className={styles.tlHead}>
        <span>Zaman çizelgesi</span>
        <span className={styles.tlStats}>
          {formatTime(total)} → <strong>{formatTime(timeline.output_duration)}</strong>
          {removed > 0.05 && <em> · {removed.toFixed(1)} sn kesildi</em>}
          {timeline.speed !== 1 && <em> · x{timeline.speed}</em>}
          {timeline.segments.length > 1 && <em> · {timeline.segments.length} parça</em>}
        </span>
      </div>
      <div className={styles.tracks} onClick={click} id="timeline-tracks">
        <div className={styles.trackLabel}>Video</div>
        <div className={styles.track}>
          <div className={styles.removedBg} />
          {timeline.segments.map(([s, e], i) => (
            <div key={i} className={styles.keep} style={{ left: pct(s), width: pct(e - s) }} title={`${s.toFixed(2)}s – ${e.toFixed(2)}s`} />
          ))}
        </div>
        <div className={styles.trackLabel}>Altyazı</div>
        <div className={styles.track}>
          {segments.map((s) => (
            <div key={s.id} className={styles.cue} style={{ left: pct(s.start), width: pct(Math.max(0.1, s.end - s.start)) }} title={s.text} />
          ))}
        </div>
        <div className={styles.trackLabel}>Katman</div>
        <div className={styles.track}>
          {music && <div className={styles.musicBar} title={`Müzik: ${String(music.track)}`}>♪ {String(music.track).replace("project:", "")}</div>}
          {texts.map((t, i) => (
            <div key={i} className={styles.textBar} style={{ left: pct(Math.min(t.start, total)), width: pct(Math.min(t.duration, total)) }} title={t.text}>
              T {t.text}
            </div>
          ))}
        </div>
        <div className={styles.playhead} style={{ left: `calc(64px + (100% - 64px) * ${Math.min(1, time / total)})` }} />
      </div>
    </div>
  );
}
