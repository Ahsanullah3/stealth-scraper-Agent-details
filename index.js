const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to prevent detection
puppeteer.use(StealthPlugin());

// =========================================================
// 1. EXPONENTIAL BACKOFF (Google API 500 Error Fix)
// =========================================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return; 
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API remains unavailable.");
                throw error;
            }
            const waitTime = (2 ** i) * 1000;
            console.log(`⚠️ Google API 500/Timeout. Retrying in ${2 ** i} seconds...`);
            await delay(waitTime);
        }
    }
}

// =========================================================
// 2. CORE SCRAPER ENGINE 
// Targeted Field Edition (Price, Split Addr, Link, Agent, Sold Price, Description)
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Targeted Stealth Scraper V10 (Split Address, Canonical Link & Description)...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Ensure we have enough columns for our new layout mapping (Columns A through S)
    if (sheet.columnCount < 19) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to 19...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: 19 });
    }

    await sheet.loadCells();

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    const FLUSH_BATCH_SIZE = 10; 
    let stagedCellsToSave = [];

    // 3. Loop through rows (rowIndex = 1 skips the header)
    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {

        const originalUrl = sheet.getCell(rowIndex, 0).value;
        const status = sheet.getCell(rowIndex, 17).value || ""; // Status shifted to Column R (index 17)

        if (!originalUrl) continue; 
        if (!originalUrl.includes("zillow.com") || status.includes("✅")) continue; 

        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Shutting down to rotate environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Scraping Row ${actualRowNumber}: ${originalUrl}`);

        const page = await browser.newPage();

        try {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await delay(Math.floor(Math.random() * 500) + 500);
            await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 17).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // 4. Extract target parameters from Next.js payload & Canonical Tag
            const extractedData = await page.evaluate(() => {
                let data = { price: "", street: "", city: "", state: "", zipcode: "", agentDetails: "", soldPrice: "", zillowLink: "", description: "" };
                
                // Native DOM extraction for canonical URL
                data.zillowLink = document.querySelector('meta[property="og:url"]')?.content || "";

                const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                if (!nextDataScript) return data;

                try {
                    const jsonData = JSON.parse(nextDataScript.innerText);
                    const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
                    if (!rawCache) return data;

                    const parsedCache = JSON.parse(rawCache);
                    const cacheKey = Object.keys(parsedCache).find(key => parsedCache[key]?.property);
                    const p = parsedCache[cacheKey]?.property;
                    
                    if (!p) return data;

                    // Formulate Agent Details & Format Phone Number strictly to (###) ###-####
                    let agentString = "";
                    if (p.attributionInfo) {
                        const name = p.attributionInfo.agentName || "";
                        const broker = p.attributionInfo.brokerName || "";
                        let rawPhone = p.attributionInfo.agentPhoneNumber || p.contactPhone || "";
                        
                        let formattedPhone = rawPhone;
                        if (rawPhone) {
                            let digits = rawPhone.replace(/^\+1/, '').replace(/\D/g, '');
                            if (digits.length === 10) {
                                formattedPhone = `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6, 10)}`;
                            }
                        }

                        agentString = `${name} | ${broker} | ${formattedPhone}`.replace(/^ \| | \| $/g, '').trim();
                    }

                    data.price = p.price || "";
                    data.street = p.address?.streetAddress || p.streetAddress || "";
                    data.city = p.address?.city || p.city || "";
                    data.state = p.address?.state || p.state || "";
                    data.zipcode = p.address?.zipcode || p.zipcode || "";
                    data.agentDetails = agentString || "N/A";
                    data.soldPrice = p.lastSoldPrice || "";
                    
                    // Extract Description with fallback
                    data.description = p.description || p.homeDescription || "N/A";

                } catch (e) {}

                return data;
            });

            // If the canonical extraction fails, fall back to the original URL
            const finalUrl = extractedData.zillowLink || originalUrl;

            // 5. Layout Memory Map (Columns J through S)
            sheet.getCell(rowIndex, 9).value = extractedData.price;            // Column J: Price
            sheet.getCell(rowIndex, 10).value = extractedData.street;          // Column K: Street
            sheet.getCell(rowIndex, 11).value = extractedData.city;            // Column L: City
            sheet.getCell(rowIndex, 12).value = extractedData.state;           // Column M: State
            sheet.getCell(rowIndex, 13).value = extractedData.zipcode;         // Column N: Zipcode
            sheet.getCell(rowIndex, 14).value = finalUrl;                      // Column O: Canonical Zillow Link
            sheet.getCell(rowIndex, 15).value = extractedData.agentDetails;    // Column P: Agent Details
            sheet.getCell(rowIndex, 16).value = extractedData.soldPrice;       // Column Q: Sold Price
            sheet.getCell(rowIndex, 17).value = "✅ SUCCESS";                  // Column R: Status Tracker
            sheet.getCell(rowIndex, 18).value = extractedData.description;     // Column S: Description

            stagedCellsToSave.push(rowIndex);
            console.log(`✔️ Staged Row ${actualRowNumber} | 💰 ${extractedData.price} | 📍 ${extractedData.city}, ${extractedData.state}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 17).value = "🛑 Error: " + e.message;
            stagedCellsToSave.push(rowIndex);
        } finally {
            await page.close();
        }

        // =========================================================
        // 6. PERIODIC BATCH WRITING
        // =========================================================
        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flashing batch of ${stagedCellsToSave.length} records to Google Sheets...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = []; 
        }
    }

    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flashing final ${stagedCellsToSave.length} trailing records to Google Sheets...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    // 7. GITHUB ACTIONS CASCADE BRIDGE
    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Remaining links found. Relaying trigger token to runner pipeline...");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Entire sheet processing execution completed!");
        }
    }
}

runScraper();
