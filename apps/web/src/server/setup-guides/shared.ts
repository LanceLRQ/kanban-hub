/** 推断不出服务地址时写进引导文件的占位符 */
export const SERVER_PLACEHOLDER = "<服务端地址>";

/** 引导文件里的地址：有就填入，没有用占位符 */
export function serverAddress(publicUrl: string | null): string {
  return publicUrl ?? SERVER_PLACEHOLDER;
}

/** 地址没推断出来时，放在文件开头的提示；有地址时为空串 */
export function missingAddressNotice(publicUrl: string | null): string {
  if (publicUrl !== null) return "";
  return `> 本文件没能确定服务端地址：文中的 \`${SERVER_PLACEHOLDER}\` 需要替换成真实地址。开始之前，先向用户询问服务端地址（形如 \`https://kanban.example.com\`），再把每一处占位符换掉。\n\n`;
}

/** 两份引导文件共同的行为约定 */
export const COMMON_RULES = `## 通用约定

- 标注了“先问用户”的步骤，必须得到用户明确同意后再执行，不要替用户决定。
- 任何命令报错时，把 kh 的输出原样告诉用户，不要改写、不要省略，也不要自行换一种办法绕过。
- 不要把令牌、配对码之外的凭据写进任何文件；\`~/.kanban-hub/credentials\` 不要读取、不要转发。`;
