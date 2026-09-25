import { getRequestConfig } from "next-intl/server";

import board from "../../messages/zh-CN/board.json";
import common from "../../messages/zh-CN/common.json";
import enums from "../../messages/zh-CN/enums.json";
import events from "../../messages/zh-CN/events.json";
import login from "../../messages/zh-CN/login.json";
import overview from "../../messages/zh-CN/overview.json";
import projectSettings from "../../messages/zh-CN/projectSettings.json";
import settings from "../../messages/zh-CN/settings.json";
import setup from "../../messages/zh-CN/setup.json";
import timeline from "../../messages/zh-CN/timeline.json";

/** 固定语言 zh-CN，不做语言路由；命名空间静态导入后合并 */
const messages = {
  common,
  enums,
  events,
  login,
  overview,
  board,
  timeline,
  setup,
  settings,
  projectSettings,
};

export default getRequestConfig(async () => ({
  locale: "zh-CN",
  // 网页一律按服务端时区格式化，与 lib/time.ts 的 serverTimeZone() 取同一个值
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  messages,
}));
