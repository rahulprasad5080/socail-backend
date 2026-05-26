const fs = require("fs");
const https = require("https");
const path = require("path");

const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const binaryDir = path.join(__dirname, "..", "node_modules", "yt-dlp-exec", "bin");
const binaryPath = path.join(binaryDir, binaryName);
const latestReleaseUrl = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

async function main() {
  if (fs.existsSync(binaryPath)) {
    console.log(`yt-dlp binary already exists at ${binaryPath}`);
    return;
  }

  fs.mkdirSync(binaryDir, { recursive: true });
  const release = await requestJson(latestReleaseUrl);
  const asset = release.assets.find((item) => item.name === binaryName);

  if (!asset || !asset.browser_download_url) {
    throw new Error(`Could not find ${binaryName} in the latest yt-dlp release`);
  }

  await downloadFile(asset.browser_download_url, binaryPath);

  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  console.log(`Downloaded yt-dlp binary to ${binaryPath}`);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "socialhub-resolver-api"
        }
      },
      (response) => {
        if (isRedirect(response.statusCode)) {
          response.resume();
          requestJson(response.headers.location).then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode > 299) {
          response.resume();
          reject(new Error(`GitHub API returned ${response.statusCode}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error("Timed out while requesting yt-dlp release metadata"));
    });
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "socialhub-resolver-api"
        }
      },
      (response) => {
        if (isRedirect(response.statusCode)) {
          response.resume();
          file.close(() => {
            fs.rmSync(destination, { force: true });
            downloadFile(response.headers.location, destination).then(resolve, reject);
          });
          return;
        }

        if (response.statusCode < 200 || response.statusCode > 299) {
          response.resume();
          file.close(() => {
            fs.rmSync(destination, { force: true });
            reject(new Error(`yt-dlp download returned ${response.statusCode}`));
          });
          return;
        }

        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      }
    );

    request.on("error", (error) => {
      file.close(() => {
        fs.rmSync(destination, { force: true });
        reject(error);
      });
    });
    request.setTimeout(120000, () => {
      request.destroy(new Error("Timed out while downloading yt-dlp"));
    });
  });
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}
