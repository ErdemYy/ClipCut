"use client";

import { useEffect, useRef, useState } from "react";
import { api, describeOp, OP_LABELS, type Project } from "@/lib/api";
import styles from "./editor-parts.module.css";

const QUICK = [
  "Sessiz yerleri at",
  "TikTok için dikey yap",
  "Sarı karaoke altyazı ekle",
  "Kelime kelime pop altyazı, büyük harf",
  "Lo-fi müzik koy",
  "Sinematik renk ve vinyet",
  "Kayma geçişleri ekle",
  "Başa 'Yeni Bölüm' başlığı ekle",
  "1.25x hızlandır",
  "Açılış ve kapanışta karart",
];

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  notify: (t: string, e?: boolean) => void;
  disabled: boolean;
};

export default function EditPanel({ project, setProject, notify, disabled }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const ops = project.plan?.operations ?? [];
  const chat = project.chat ?? [];

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length, busy]);

  const send = async (text = prompt) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setPrompt("");
    try {
      const res = await api.edit(project.id, text.trim());
      setProject(res.project);
    } catch (e) {
      notify((e as Error).message, true);
      setPrompt(text);
    } finally {
      setBusy(false);
    }
  };

  const removeOp = async (index: number) => {
    const plan = { operations: ops.filter((_, i) => i !== index) };
    setProject(await api.setPlan(project.id, plan));
  };

  const undo = async () => {
    try {
      setProject(await api.undo(project.id));
      notify("Son değişiklik geri alındı");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className={styles.editPanel}>
      <div className={styles.chat} ref={chatRef} id="edit-chat">
        {chat.length === 0 && (
          <div className={styles.chatEmpty}>
            <span>✨</span>
            <h3>Ne yapmak istediğini yaz</h3>
            <p>Doğal dille anlat; ClipCut bunu bir edit planına çevirir. Birden fazla isteği tek cümlede verebilirsin.</p>
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgAi}`}>
            {m.text}
          </div>
        ))}
        {busy && (
          <div className={`${styles.msg} ${styles.msgAi} ${styles.thinking}`}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className={styles.quick}>
        {QUICK.map((q) => (
          <button key={q} className="chip" onClick={() => send(q)} disabled={busy || disabled}>
            {q}
          </button>
        ))}
      </div>

      <div className={styles.composer}>
        <textarea
          id="edit-prompt"
          className="textarea"
          rows={2}
          placeholder="Örn: Sessiz yerleri at, dikey yap, mor vurgulu altyazı ve enerjik müzik ekle…"
          value={prompt}
          disabled={busy || disabled}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button id="edit-send" className="btn btn-primary" onClick={() => send()} disabled={busy || disabled || !prompt.trim()}>
          {busy ? <span className="spinner" /> : "Uygula"}
        </button>
      </div>

      <div className={styles.planHead}>
        <h4>Edit planı · {ops.length}</h4>
        <div>
          <button id="plan-undo" className="btn btn-sm" onClick={undo} disabled={!project.can_undo}>
            ↶ Geri al
          </button>
        </div>
      </div>
      {ops.length === 0 ? (
        <p className={styles.muted}>Plan boş. Yukarıdan bir komut ver.</p>
      ) : (
        <ul className={styles.ops}>
          {ops.map((op, i) => (
            <li key={`${op.type}-${i}`} className={styles.op}>
              <span className={styles.opIcon}>{OP_LABELS[op.type]?.icon ?? "•"}</span>
              <div>
                <strong>{OP_LABELS[op.type]?.label ?? op.type}</strong>
                <small>{describeOp(op)}</small>
              </div>
              <button className={styles.opRemove} onClick={() => removeOp(i)} title="Kaldır" id={`op-remove-${i}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
