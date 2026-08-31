import { existsSync } from "node:fs";
import { launch } from "./browser.ts";

/** Sync is JMAP-driven now (see src/commands/sync.ts); only the login
 *  flow remains here. */
const LOGIN_URL = "https://app.fastmail.com";

export interface LoginArgs {
  auth: string;
  chromium?: string;
}

export async function loginFlow(args: LoginArgs): Promise<void> {
  console.log("Launching headed browser. Complete login in the window.");
  const browser = await launch({ chromium: args.chromium, headed: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL);

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (!url.includes("/login") && !url.includes("/signup") && (url.includes("/mail") || url.includes("/settings"))) {
        break;
      }
      await page.waitForTimeout(1500);
    }
    if (page.url().includes("/login")) {
      throw new Error("Login not completed within 10 minutes.");
    }

    await context.storageState({ path: args.auth });
    console.log(`Saved session to ${args.auth}.`);
  } finally {
    await browser.close();
  }
}
