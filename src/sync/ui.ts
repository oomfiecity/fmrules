import { existsSync } from "node:fs";
import { launch } from "./browser.ts";
import type { LatestRules } from "./release.ts";

export interface SyncArgs {
  auth: string;
  rules: LatestRules;
  chromium?: string;
  headed?: boolean;
}

const FILTERS_URL = "https://app.fastmail.com/settings/filters";
const LOGIN_URL = "https://app.fastmail.com";

export async function syncRules(args: SyncArgs): Promise<void> {
  if (!existsSync(args.auth)) {
    throw new Error(`Auth file not found at ${args.auth}. Run \`fmrules login\` first.`);
  }

  const { rules } = args;
  console.log(`Syncing ${rules.count} rules from ${rules.name}. Launching browser...`);

  const browser = await launch({ chromium: args.chromium, headed: args.headed });
  try {
    const context = await browser.newContext({ storageState: args.auth });
    const page = await context.newPage();

    await page.goto(FILTERS_URL);

    const selectAllLabel = page.locator('label[title*="Select all"]');
    await selectAllLabel.waitFor({ state: "visible" });

    if (!(page.url().includes("filters"))) {
      throw new Error("URL did not match after page load. Try `fmrules login`.");
    } else {
      console.log("Fastmail loaded.");
    }

    const list = selectAllLabel.locator("..").locator("xpath=following-sibling::ul");
    const listItems = list.locator("li");

    console.log("Attempting to delete existing rules...");
    const existingCount = await listItems.count();
    if (existingCount <= 0) {
      console.log("No existing rules to delete. Importing anyway.");
    } else {
      await selectAllLabel.click({ force: true });
      const selectAllCheckbox = page.getByRole("checkbox", { name: "Select all" });
      if (!(await selectAllCheckbox.isChecked())) {
        throw new Error("Failed to check 'Select all' after clicking label.");
      }
      const deleteResponsePromise = page.waitForResponse(async (res) => {
        try {
          const data = await res.json();
          const methodResp = data?.methodResponses?.[0];
          if (methodResp?.[0] === "Rule/set") {
            const destroyed = methodResp?.[1]?.destroyed;
            return destroyed && Object.keys(destroyed).length === existingCount;
          }
        } catch {
          return false;
        }
        return false;
      }, { timeout: 10000 });

      const deleteAll = page.getByRole("button", { name: "Delete" });
      const deleteNotification = page.locator(".v-Notification");
      await deleteAll.click();
      await deleteNotification.waitFor({ state: "visible" });
      const deleteText = (await deleteNotification.innerText()).toLowerCase();
      if (!/delete/.test(deleteText)) {
        throw new Error(`Delete notification unexpected: ${deleteText}`);
      }
      console.log(`Deleted ${existingCount} rules.`);
      try {
        const deleteResponse = await deleteResponsePromise;
        if (deleteResponse) {
          console.log(`Delete confirmed.`);
        } else {
          throw new Error(`Server did not confirm deletion within 10s.`);
        }
      } catch (e) {
        throw new Error(`Error fetching rule sync response from fastmail server.`);
      }
    }

    const remaining = await listItems.count();
    if (remaining !== 0) {
      throw new Error(`Expected 0 rules after delete, found ${remaining}.`);
    }

    await page.reload();

    console.log(`Importing ${rules.count} rules...`);
    await page.getByRole("button", { name: "Import…" }).click();

    const fileInput = page.locator("input.v-FileButton-input");
    await fileInput.setInputFiles({
      name: rules.name,
      mimeType: rules.mimeType,
      buffer: rules.buffer,
    });

    const importAllRadio = page.getByRole("radio", { name: "Import All" });
    if (!(await importAllRadio.isChecked())) {
      throw new Error("'Import All' radio was not checked by default.");
    }

    const importResponsePromise = page.waitForResponse(async (res) => {
      try {
        const data = await res.json();
        const methodResp = data?.methodResponses?.[0];
        if (methodResp?.[0] === "Rule/set") {
          const created = methodResp?.[1]?.created;
          return created && Object.keys(created).length === rules.count;
        }
      } catch {
        return false;
      }
      return false;
    }, { timeout: 10000 });

    const importNotification = page.locator(".v-Notification");
    await page.getByRole("button", { name: "Import" }).click();
    await importNotification.waitFor({ state: "visible" });

    const notificationText = await importNotification.innerText();
    if (!/imported/i.test(notificationText)) {
      throw new Error(`Import notification unexpected: ${notificationText}`);
    }

    const messageText = await importNotification.locator(".v-Notification-message").innerText();
    const match = messageText.match(/[\d,]+/)?.[0] ?? "0";
    const imported = parseInt(match.replace(/,/g, ""), 10);
    if (imported !== rules.count) {
      throw new Error(`Imported ${imported} rules, expected ${rules.count}.`);
    }
    console.log(`Imported ${imported} rules.`);
    try {
      const importResponse = await importResponsePromise;
      if (importResponse) {
        console.log(`Import confirmed. Quitting.`);
      } else {
        throw new Error(`Server did not confirm creation of ${rules.count} rules within 10s.`);
      }
    } catch (e) {
      throw new Error(`Error fetching rule sync response from fastmail server.`);
    }
  } finally {
    await browser.close();
  }
}

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
