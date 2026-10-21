"use client";

import { useEffect, useState } from "react";
import { api, describeOp, OP_LABELS, type Project, type Template } from "@/lib/api";
import styles from "./editor-parts.module.css";

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  notify: (t: string, e?: boolean) => void;
  disabled: boolean;
};

export default function TemplatesPanel({ project, setProject, notify, disabled }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => {});
  }, []);

  const apply = async (tmpl: Template) => {
    if (disabled || loading) return;
    setLoading(true);
    setSelectedId(tmpl.id);
    try {
      const res = await api.applyTemplate(project.id, tmpl.id);
      setProject(res.project);
      notify(`“${tmpl.name}” şablonu uygulandı!`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.hero}>
        <span>⚡</span>
        <h3>Hazır Video Şablonları</h3>
        <p>Popüler platformlara uygun optimize edilmiş kurgu, altyazı ve müzik kombinasyonları.</p>
      </div>

      <div className={styles.templateList}>
        {templates.map((t) => {
          const ops = t.plan?.operations ?? [];
          return (
            <article key={t.id} className={`${styles.templateCard} glass`} id={`template-${t.id}`}>
              <div className={styles.templateHead}>
                <span className={styles.templateIcon}>{t.icon}</span>
                <div className={styles.templateMeta}>
                  <div className={styles.templateTitleRow}>
                    <strong>{t.name}</strong>
                    <span className="badge" style={{ color: t.badge_color || "var(--magenta)", background: "rgba(255,255,255,0.06)" }}>
                      {t.tag}
                    </span>
                  </div>
                  <p>{t.description}</p>
                </div>
              </div>

              <div className={styles.templateOps}>
                {ops.map((op, i) => (
                  <span key={i} className="chip" title={describeOp(op)}>
                    {OP_LABELS[op.type]?.icon ?? "•"} {OP_LABELS[op.type]?.label ?? op.type}
                  </span>
                ))}
              </div>

              <button
                id={`apply-template-${t.id}`}
                className="btn btn-primary btn-sm"
                onClick={() => apply(t)}
                disabled={disabled || loading}
              >
                {loading && selectedId === t.id ? <span className="spinner" /> : "⚡ Bu Şablonu Uygula"}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
