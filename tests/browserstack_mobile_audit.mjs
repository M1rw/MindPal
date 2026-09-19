import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Builder, By, until } from 'selenium-webdriver';

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
const stagingUrl = process.env.MINDPAL_STAGING_URL;
const projectName = process.env.BROWSERSTACK_PROJECT || 'MindPal mobile audit';
const buildName = process.env.BROWSERSTACK_BUILD || `mobile-${new Date().toISOString()}`;
const outputDir = 'artifacts/frontend-quality/browserstack-mobile';

if (!username || !accessKey || !stagingUrl) {
  console.error('Required environment variables: BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY, MINDPAL_STAGING_URL');
  process.exit(2);
}

const devices = [
  {
    name: 'iphone-safari',
    capabilities: {
      platformName: 'ios',
      browserName: 'Safari',
      'appium:deviceName': process.env.BROWSERSTACK_IOS_DEVICE || 'iPhone 14',
      'appium:platformVersion': process.env.BROWSERSTACK_IOS_VERSION || '16',
    },
  },
  {
    name: 'android-chrome',
    capabilities: {
      platformName: 'android',
      browserName: 'Chrome',
      'appium:deviceName': process.env.BROWSERSTACK_ANDROID_DEVICE || 'Samsung Galaxy S22',
      'appium:platformVersion': process.env.BROWSERSTACK_ANDROID_VERSION || '12',
    },
  },
];

const report = {
  startedAt: new Date().toISOString(),
  stagingUrl,
  devices: [],
};

async function buildDriver(device) {
  return new Builder()
    .usingServer('https://hub-cloud.browserstack.com/wd/hub')
    .withCapabilities({
      ...device.capabilities,
      'bstack:options': {
        userName: username,
        accessKey,
        projectName,
        buildName,
        sessionName: `MindPal ${device.name} mobile flow`,
        networkLogs: true,
        consoleLogs: 'errors',
        video: true,
      },
    })
    .build();
}

async function firstDisplayed(elements) {
  for (const element of elements) {
    if (await element.isDisplayed()) return element;
  }
  return null;
}

async function runDevice(device) {
  const result = { name: device.name, passed: false, checks: [], errors: [] };
  let driver;
  let currentStep = 'create session';
  try {
    driver = await buildDriver(device);
    const actualCapabilities = await driver.getCapabilities();
    result.capabilities = actualCapabilities.toJSON ? actualCapabilities.toJSON() : actualCapabilities;
    const actualPlatform = String(result.capabilities.platformName || result.capabilities.platform || '').toLowerCase();
    assert.ok(actualPlatform.includes(device.name.startsWith('iphone') ? 'ios' : 'android'), `Unexpected platform: ${actualPlatform}`);
    currentStep = 'open staging URL';
    await driver.get(stagingUrl);
    if (device.name === 'android-chrome') {
      currentStep = 'prepare clean mobile session';
      await driver.executeScript("localStorage.setItem('mindpal_last_seen_changelog', '5.0.0'); location.reload();");
      await driver.sleep(1_000);
    }
    currentStep = 'dismiss release notes';
    const releaseContinue = await driver.findElements(By.xpath("//button[normalize-space()='Continue']"));
    const visibleReleaseContinue = await firstDisplayed(releaseContinue);
    if (visibleReleaseContinue) {
      await visibleReleaseContinue.click();
    } else {
      const releaseClose = await driver.findElements(By.css('button[aria-label="Close release notes"]'));
      const visibleReleaseClose = await firstDisplayed(releaseClose);
      if (visibleReleaseClose) await visibleReleaseClose.click();
    }
    await driver.sleep(500);
    const releaseStillOpen = await driver.findElements(By.css('#changelog-modal:not([aria-hidden="true"]) .overlay-backdrop.is-open'));
    if (releaseStillOpen.length > 0 && visibleReleaseContinue) {
      await driver.executeScript('arguments[0].click()', visibleReleaseContinue);
      await driver.sleep(500);
    }
    currentStep = 'locate composer';
    const input = await driver.wait(until.elementLocated(By.css('textarea[placeholder="Ask MindPal"]')), 30_000);
    await driver.wait(until.elementIsVisible(input), 30_000);

    const geometry = await driver.executeScript(() => {
      const controls = [...document.querySelectorAll('button, input, textarea, select, [role="button"]')]
        .filter((element) => element.getClientRects().length)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim(),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        controls,
      };
    });

    assert.ok(geometry.documentWidth <= geometry.viewport.width + 1, 'Document has horizontal overflow');
    assert.ok(geometry.bodyWidth <= geometry.viewport.width + 1, 'Body has horizontal overflow');
    assert.ok(geometry.controls.every((control) => control.label), 'Every visible control must be named');
    result.checks.push('initial layout', 'named controls', 'no horizontal overflow');

    currentStep = 'open mobile actions';
    const mobileActions = await driver.findElements(By.css('button[aria-label="More actions"]'));
    if (mobileActions.length > 0 && await mobileActions[0].isDisplayed()) {
      await mobileActions[0].click();
      currentStep = 'open history from mobile actions';
      await driver.findElement(By.css('[role="menuitem"][aria-label="Open chat history"]')).click();
    } else {
      currentStep = 'open history from desktop header';
      await driver.findElement(By.css('button[aria-label="Open chat history"]')).click();
    }
    currentStep = 'wait for history';
    await driver.wait(until.elementLocated(By.css('[role="dialog"]')), 10_000);
    currentStep = 'close history';
    await driver.findElement(By.css('button[aria-label="Close history"]')).click();
    result.checks.push('mobile actions menu', 'history open and close');

    currentStep = 'type composer input';
    await input.sendKeys('BrowserStack mobile audit message');
    assert.equal(await input.getAttribute('value'), 'BrowserStack mobile audit message');
    result.checks.push('composer input');

    await writeFile(`${outputDir}/${device.name}.png`, await driver.takeScreenshot(), 'base64');
    result.passed = true;
  } catch (error) {
    result.errors.push(`${currentStep}: ${error instanceof Error ? error.message : String(error)}`);
    if (driver) {
      try {
        result.diagnostics = await driver.executeScript(() => ({
          readyState: document.readyState,
          rootHtmlLength: document.getElementById('root')?.innerHTML.length ?? 0,
          bodyText: document.body?.innerText?.slice(0, 500) ?? '',
          scriptSources: [...document.scripts].map((script) => script.src).filter(Boolean),
        }));
      } catch {
        result.diagnostics = { unavailable: true };
      }
      try {
        result.browserLogs = await driver.manage().logs().get('browser');
      } catch {
        result.browserLogs = [];
      }
      try {
        await writeFile(`${outputDir}/${device.name}-failure.png`, await driver.takeScreenshot(), 'base64');
        await writeFile(`${outputDir}/${device.name}-failure.html`, await driver.getPageSource(), 'utf8');
      } catch {
        // Preserve the original failure when the remote session is already gone.
      }
    }
  } finally {
    await driver?.quit();
  }
  return result;
}

await mkdir(outputDir, { recursive: true });
for (const device of devices) {
  report.devices.push(await runDevice(device));
}
report.finishedAt = new Date().toISOString();
await writeFile(`${outputDir}/latest.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify(report, null, 2));
if (report.devices.some((device) => !device.passed)) process.exitCode = 1;