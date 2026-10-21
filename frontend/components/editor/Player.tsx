"use client";

import { type Ref, useEffect, useMemo, useState } from "react";
import type { Operation, Project, Word } from "@/lib/api";
import styles from "./editor-parts.module.css";

const ASPECTS: Record<string, string> = { "9:16": "9 / 16", "1:1": "1 / 1", "16:9": "16 / 9", "4:5": "4 / 5" };
const AUTO_WORDS: Record<string, number> = { classic: 7, karaoke: 4, word_pop: 3, boxed: 6, minimal: 7 };
const COLOR_FILTERS: Record<string, string> = {
  none: "",
  cinematic: "contrast(1.12) saturate(0.88) sepia(0.08)",
  vibrant: "saturate(1.45) contrast(1.06)",
  warm: "sepia(0.18) saturate(1.1)",
  cool: "hue-rotate(-8deg) saturate(0.95) brightness(1.02)",
  bw: "grayscale(1) contrast(1.15)",
  vintage: "sepia(0.35) contrast(0.95) saturate(0.85)",
  moody: "contrast(1.2) brightness(0.92) saturate(0.75)",
  bright: "brightness(1.08) contrast(1.05) saturate(1.15)",
};

type Props = {
  ref: Ref<HTMLVideoElement>;
  project: Project;
  view: "source" | "output";
  src?: string;
  onTime: (t: number) => void;
};

function find(ops: Operation[] | undefined, type: string) {
  return ops?.find((o) => o.type === type) as Record<string, unknown> | undefined;
}

export default function Player({ ref, project, view, src, onTime }: Props) {
  const ops = project.plan?.operations;
  const preview = view === "source";
  const sub = preview ? find(ops, "subtitles") : undefined;
  const reframe = preview ? find(ops, "reframe") : undefined;
  const color = preview ? find(ops, "color_grade") : undefined;

  const aspect =
    view === "output" && project.output_meta
      ? `${project.output_meta.width} / ${project.output_meta.height}`
      : reframe && reframe.aspect_ratio !== "original"
        ? ASPECTS[String(reframe.aspect_ratio)]
        : `${project.width || 16} / ${project.height || 9}`;

  const filter = color ? (COLOR_FILTERS[String(color.preset)] ?? "") : "";
  const fit = reframe?.mode === "crop" ? "cover" : "contain";

  return (
    <div className={styles.playerWrap}>
      <div className={styles.frame} style={{ aspectRatio: aspect }}>
        {reframe?.mode === "blur" && <div className={styles.blurBg} />}
        <video
          ref={ref}
          key={src}
          src={src}
          controls
          playsInline
          className={styles.video}
          style={{ objectFit: fit as "cover" | "contain", filter }}
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
          id="editor-video"
        />
        {color?.vignette ? <div className={styles.vignette} /> : null}
        {sub && sub.enabled !== false && project.subtitles && <SubtitleOverlay sub={sub} project={project} />}
      </div>
      {preview && (sub || reframe || color) && (
        <p className={styles.previewNote}>Canlı önizleme yaklaşık bir görünümdür; kesin sonuç için render alın.</p>
      )}
    </div>
  );
}

function SubtitleOverlay({ sub, project }: { sub: Record<string, unknown>; project: Project }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const v = document.getElementById("editor-video") as HTMLVideoElement | null;
      if (v) setT(v.currentTime);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const style = String(sub.style ?? "karaoke");
  const maxWords = Number(sub.max_words_per_line) || AUTO_WORDS[style] || 5;

  const chunks = useMemo(() => {
    const out: Word[][] = [];
    for (const seg of project.subtitles?.segments ?? []) {
      for (let i = 0; i < seg.words.length; i += maxWords) out.push(seg.words.slice(i, i + maxWords));
    }
    return out;
  }, [project.subtitles, maxWords]);

  const chunk = chunks.find((c) => t >= c[0].start - 0.05 && t <= c[c.length - 1].end + 0.25);
  if (!chunk) return null;

  const pos = String(sub.position ?? "bottom");
  const size = { small: 0.75, medium: 1, large: 1.3 }[String(sub.size ?? "medium")] ?? 1;
  const upper = Boolean(sub.uppercase);
  const primary = String(sub.primary_color ?? "#FFFFFF");
  const highlight = String(sub.highlight_color ?? "#FFD400");
  const outline = String(sub.outline_color ?? "#000000");

  return (
    <div
      className={`${styles.subOverlay} ${styles[`pos_${pos}`]}`}
      style={{ fontFamily: `"${String(sub.font ?? "Montserrat")}", var(--font-display)`, fontSize: `calc(clamp(14px, 3.6cqw, 40px) * ${size})` }}
    >
      <span
        className={`${styles.subLine} ${styles[`st_${style}`]}`}
        style={
          {
            color: primary,
            "--outline": outline,
            textTransform: upper ? "uppercase" : "none",
          } as React.CSSProperties
        }
      >
        {chunk.map((w, i) => {
          const active = t >= w.start && t < (chunk[i + 1]?.start ?? w.end + 0.25);
          const spoken = t >= w.start;
          const color = style === "karaoke" ? (spoken ? highlight : primary) : style === "word_pop" && active ? highlight : primary;
          return (
            <span key={`${w.start}-${i}`} className={active && style === "word_pop" ? styles.popWord : ""} style={{ color }}>
              {w.text}{" "}
            </span>
          );
        })}
      </span>
    </div>
  );
}
