/** 接入页上“可以直接复制给 agent 的话”的拼法；文案模板在 messages 里，这里只负责填入地址与配对码 */
export type SentenceKey = "sentences.agent" | "sentences.migrate";
export type SentenceTranslate = (key: SentenceKey, values: Record<string, string>) => string;

/** 接入本机：地址推断不出来（空串）时用占位符 */
export function agentSentence(publicUrl: string, code: string, placeholder: string, translate: SentenceTranslate): string {
  return translate("sentences.agent", { url: publicUrl || placeholder, code });
}

/** 接入当前仓库 */
export function migrateSentence(publicUrl: string, placeholder: string, translate: SentenceTranslate): string {
  return translate("sentences.migrate", { url: publicUrl || placeholder });
}
