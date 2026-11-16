// Playwright（Chromium）管理と、ページへ抽出バンドルを注入する処理
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SubscriptionConfig, Cond } from "@ws/shared";
import type { PageExtraction, ListSnapshot, CondResult, Outline } from "@ws/shared/dom";
import { assertPublicUrl, browserUserAgent, politeWait, userAgent } from "./net.js";
import { settings } from "./settings.js";

let browserP: Promise<Browser> | null = null;
let injectSrc: string | null = null;

function bundle(): string {
  if (!injectSrc) {
    const p = fileURLToPath(new URL(process.env.WS_INJECT_PATH ?? "../dist/inject.js", import.meta.url));
    injectSrc = readFileSync(p, "utf8") + "\n;window.__ws = __wsBundle.api;";
  }
  return injectSrc;
}

export async function getBrowser(): Promise<Browser> {
  if (!browserP) {
    browserP = chromium.launch({ headless: settings.headless, args: ["--disable-dev-shm-usage"] });
    browserP.then((b) => b.on("disconnected", () => (browserP = null)));
  }
  return browserP;
}

export async function engineVersion(): Promise<string> {
  const b = await getBrowser();
  return `chromium/${b.version()}`;
}

export async function closeBrowser() {
  if (browserP) (await browserP).close().catch(() => {});
  browserP = null;
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  /** 主文書ナビゲーションのレスポンス（最新） */
  lastMainResponse: () => { url: string; status: number } | null;
  subresourceFailures: () => number;
  close: () => Promise<void>;
}

let chromiumUa: string | null = null;

export async function openPage(cfg: SubscriptionConfig, mode: "browser" | "static", staticDoc?: { url: string; status: number; body: string; headers: Record<string, string> }): Promise<OpenedPage> {
  const b = await getBrowser();
  if (!chromiumUa) {
    const tmp = await b.newPage();
    chromiumUa = await tmp.evaluate(() => navigator.userAgent);
    await tmp.close();
  }
  const context = await b.newContext({
    userAgent: mode === "browser" ? browserUserAgent(chromiumUa) : userAgent(),
    viewport: cfg.fetch.browser.viewport ?? { width: 1280, height: 2000 },
    extraHTTPHeaders: cfg.fetch.headers,
    locale: "ja-JP",
    timezoneId: cfg.timezone,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  let lastMain: { url: string; status: number } | null = null;
  let subFailures = 0;
  const block = new Set<string>(cfg.fetch.browser.block_resource_types);

  if (mode === "static") {
    // http方式：取得済みHTMLをJS無効（CSPで全スクリプト禁止）で読み込み、同じ抽出器を使う
    const doc = staticDoc!;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && req.url() === doc.url) {
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'none'; object-src 'none'; frame-src 'none'" };
        await route.fulfill({ status: 200, headers, body: doc.body });
      } else await route.abort();
    });
    lastMain = { url: doc.url, status: doc.status };
  } else {
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        try {
          await assertPublicUrl(req.url());
        } catch {
          return route.abort("blockedbyclient");
        }
        await politeWait(req.url(), cfg.politeness.min_interval_ms);
        return route.continue();
      }
      if (block.has(req.resourceType())) return route.abort();
      return route.continue();
    });
    page.on("response", (r: Response) => {
      const req = r.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastMain = { url: r.url(), status: r.status() };
      else if (r.status() >= 400) subFailures++;
    });
    page.on("requestfailed", (req) => {
      if (!(req.isNavigationRequest() && req.frame() === page.mainFrame())) subFailures++;
    });
  }
  return {
    context,
    page,
    lastMainResponse: () => lastMain,
    subresourceFailures: () => subFailures,
    close: () => context.close().catch(() => {}),
  };
}

export async function inject(page: Page) {
  const has = await page.evaluate(() => typeof (window as unknown as { __ws?: unknown }).__ws !== "undefined").catch(() => false);
  if (!has) await page.evaluate(bundle());
}

type WsApi = {
  installTracker(): void;
  extract(c: SubscriptionConfig, baseUrl?: string): PageExtraction;
  evalCond(cond: Cond, c: SubscriptionConfig, before: ListSnapshot | null): CondResult;
  listSnapshot(c: SubscriptionConfig): ListSnapshot;
  inspectNext(c: SubscriptionConfig): { count: number; index: number | null; disabled: boolean; error?: string };
  buildOutline(max?: number): Outline;
  inspectSelector(sel: unknown): { count: number; samples: string[]; error?: string };
  serialize(): string;
};

export async function ws<K extends keyof WsApi>(page: Page, fn: K, ...args: Parameters<WsApi[K]>): Promise<ReturnType<WsApi[K]>> {
  await inject(page);
  return page.evaluate(
    ([f, a]) => {
      const w = (window as unknown as { __ws: Record<string, (...x: unknown[]) => unknown> }).__ws;
      return w[f as string](...(a as unknown[]));
    },
    [fn, args] as const,
  ) as Promise<ReturnType<WsApi[K]>>;
}
