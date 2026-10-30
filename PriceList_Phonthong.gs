/**
 * สร้างเมนูเมื่อเปิดไฟล์ Google Sheet
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('พิมพ์และส่งออก PDF')
    .addItem('🚀 ส่งออก 4 ชีต + สร้างคิว JPG', 'exportAllSheetsToPDF')
    .addSeparator() // เส้นคั่นเมนู
    .addItem('📁 เปิดโฟลเดอร์เป้าหมาย (Target Folder)', 'openTargetFolder')
    .addItem('🗂️ เปิดโฟลเดอร์สำรอง (Backup Folder)', 'openBackupFolder')
    .addItem('🖼️ เปิดโฟลเดอร์คิว JPG', 'openQuoteQueueFolder')
    .addToUi();
}

/**
 * ตั้งค่าครั้งแรก: เติม defaults ลง Script Properties, สร้างคิว/สถานะ และตรวจชีต.
 * TARGET_FOLDER_ID และ BACKUP_FOLDER_ID ต้องตั้งไว้ก่อน.
 */
function setupQuoteImageExport() {
  const props = PropertiesService.getScriptProperties();
  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!activeSpreadsheet) throw new Error('กรุณารัน setupQuoteImageExport จาก Apps Script ที่ผูกกับ Google Sheet นี้');
  props.setProperty('QUOTE_EXPORT_SPREADSHEET_ID', activeSpreadsheet.getId());
  const targetFolderId = props.getProperty('TARGET_FOLDER_ID');
  const backupFolderId = props.getProperty('BACKUP_FOLDER_ID');
  if (!targetFolderId || !backupFolderId) {
    throw new Error('กรุณาตั้ง TARGET_FOLDER_ID และ BACKUP_FOLDER_ID ใน Script Properties ก่อน');
  }

  const targetFolder = DriveApp.getFolderById(targetFolderId);
  DriveApp.getFolderById(backupFolderId); // ตรวจสิทธิ์และความถูกต้องของโฟลเดอร์สำรอง

  let rawSheetNames = props.getProperty('QUOTE_EXPORT_SHEET_NAMES');
  if (!rawSheetNames) {
    rawSheetNames = JSON.stringify(['หมูกระทะ', 'ชาบู', 'ร้านชำ', 'หมึกย่าง']);
    props.setProperty('QUOTE_EXPORT_SHEET_NAMES', rawSheetNames);
  }
  let sheetNames;
  try { sheetNames = JSON.parse(rawSheetNames); } catch (e) {
    throw new Error('QUOTE_EXPORT_SHEET_NAMES ต้องเป็น JSON array ของชื่อชีต');
  }
  if (!Array.isArray(sheetNames) || sheetNames.length !== 4 || new Set(sheetNames).size !== 4 ||
      sheetNames.some(function (name) { return typeof name !== 'string' || !name.trim(); }) ||
      !hasAllCustomerTypes_(sheetNames)) {
    throw new Error('QUOTE_EXPORT_SHEET_NAMES ต้องมีชื่อชีตไม่ซ้ำกันครบทั้ง 4 CustomerType');
  }

  let queueFolderId = props.getProperty('QUOTE_EXPORT_QUEUE_FOLDER_ID');
  if (!queueFolderId) {
    const queueFolder = targetFolder.createFolder('_JPG_QUEUE');
    queueFolderId = queueFolder.getId();
    props.setProperty('QUOTE_EXPORT_QUEUE_FOLDER_ID', queueFolderId);
  }
  DriveApp.getFolderById(queueFolderId);

  let statusSheetName = props.getProperty('QUOTE_EXPORT_STATUS_SHEET_NAME');
  if (!statusSheetName) {
    statusSheetName = 'สถานะส่งออก JPG';
    props.setProperty('QUOTE_EXPORT_STATUS_SHEET_NAME', statusSheetName);
  }
  if (!props.getProperty('QUOTE_EXPORT_STATUS_TOKEN')) {
    props.setProperty('QUOTE_EXPORT_STATUS_TOKEN', Utilities.getUuid() + Utilities.getUuid());
  }

  const ss = activeSpreadsheet;
  const missingSheets = sheetNames.filter(function (name) { return !ss.getSheetByName(name); });
  if (missingSheets.length) throw new Error('ไม่พบชีต: ' + missingSheets.join(', '));
  ensureQuoteExportStatusSheet_(ss, statusSheetName);

  return 'ตั้งค่าส่วนส่งออก JPG แล้ว\nคิวงาน: ' + DriveApp.getFolderById(queueFolderId).getUrl() +
    '\nชื่อชีต: ' + sheetNames.join(', ') +
    '\nกรุณาตั้งค่า QUOTE_WORKER_BASE_URL และ QUOTE_WORKER_API_TOKEN หลัง deploy Worker';
}

/**
 * ฟังก์ชันหลักสำหรับ Export PDF ทั้ง 4 ชีต, เก็บไฟล์เดิมใน Backup,
 * แล้วคัดลอก PDF เป็น job เฉพาะในคิวให้ PC agent.
 */
function exportAllSheetsToPDF() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getUi().alert('มีงานส่งออกอีกงานกำลังทำงานอยู่ กรุณาลองใหม่');
    return;
  }
  const scriptProperties = PropertiesService.getScriptProperties();
  let jobId = '';
  let jobFolder = null;
  let manifestCreated = false;
  try {
    const ss = getQuoteSpreadsheet_();
    const targetFolderId = scriptProperties.getProperty('TARGET_FOLDER_ID');
    const backupFolderId = scriptProperties.getProperty('BACKUP_FOLDER_ID');
    const queueFolderId = scriptProperties.getProperty('QUOTE_EXPORT_QUEUE_FOLDER_ID');
    const statusSheetName = scriptProperties.getProperty('QUOTE_EXPORT_STATUS_SHEET_NAME');
    const rawSheetNames = scriptProperties.getProperty('QUOTE_EXPORT_SHEET_NAMES');
    if (!targetFolderId || !backupFolderId || !queueFolderId || !statusSheetName || !rawSheetNames) {
      SpreadsheetApp.getUi().alert('กรุณารัน setupQuoteImageExport() หลังตั้ง TARGET_FOLDER_ID และ BACKUP_FOLDER_ID');
      return;
    }
    const sheetNames = JSON.parse(rawSheetNames);
    if (!Array.isArray(sheetNames) || sheetNames.length !== 4 || new Set(sheetNames).size !== 4 ||
        !hasAllCustomerTypes_(sheetNames)) {
      throw new Error('QUOTE_EXPORT_SHEET_NAMES ต้องมีชื่อชีตไม่ซ้ำกันครบทั้ง 4 CustomerType');
    }
    const sheets = sheetNames.map(function (name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) throw new Error('ไม่พบชีตชื่อ: ' + name);
      return sheet;
    });
    const targetFolder = DriveApp.getFolderById(targetFolderId);
    const backupFolder = DriveApp.getFolderById(backupFolderId);
    const queueFolder = DriveApp.getFolderById(queueFolderId);
    const createdAt = new Date().toISOString();
    jobId = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + '_' +
      Utilities.getUuid().replace(/-/g, '').slice(0, 8);

    SpreadsheetApp.flush();
    const pdfBlobs = sheets.map(function (sheet) {
      const blob = getSheetAsPDFBlob_(ss.getId(), sheet.getSheetId());
      return { sheetName: sheet.getName(), blob: blob.setName(sheet.getName() + '.pdf') };
    });

    // คิวเป็น immutable job folder เพื่อให้ PC ไม่อ่าน PDF คนละรอบกับ manifest.
    jobFolder = queueFolder.createFolder(jobId);
    const manifestFiles = [];
    pdfBlobs.forEach(function (entry) {
      const sheetName = entry.sheetName;
      const fileName = sheetName + '.pdf';

      // เก็บ PDF เดิมใน Backup Folder ก่อนแทนที่ไฟล์ชื่อเดิมใน Target Folder.
      const existingFiles = targetFolder.getFilesByName(fileName);
      while (existingFiles.hasNext()) {
        const oldFile = existingFiles.next();
        const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
        oldFile.moveTo(backupFolder);
        oldFile.setName(sheetName + '_backup_' + timestamp + '.pdf');
      }

      const targetFile = targetFolder.createFile(entry.blob.copyBlob().setName(fileName));
      const queueFile = targetFile.makeCopy(fileName, jobFolder);
      manifestFiles.push({
        customerType: sheetName,
        pdfName: fileName,
        driveFileId: queueFile.getId()
      });
    });

    // เขียนสถานะก่อน manifest เพื่อไม่ให้ callback PROCESSING ถูกเขียนทับเป็น QUEUED.
    recordQuoteExportStatus_(jobId, 'QUEUED', 'PDF ครบ 4 ชีต รอ PC แปลงและอัปโหลด', '');
    // manifest เป็น marker ให้ PC เริ่มงาน; สร้างหลัง PDF ทั้งสี่ไฟล์เท่านั้น.
    const manifest = { protocolVersion: 1, jobId: jobId, createdAt: createdAt, files: manifestFiles };
    const manifestFile = jobFolder.createFile('manifest.json', JSON.stringify(manifest), MimeType.PLAIN_TEXT);
    manifestCreated = true;
    try { setQuoteExportManifestUrl_(jobId, manifestFile.getUrl()); } catch (statusUrlError) { Logger.log(statusUrlError); }
    try { SpreadsheetApp.getActive().toast('ส่งออก PDF และสร้างคิว JPG แล้ว: ' + jobId, 'ใบเสนอราคา', 8); } catch (toastError) { Logger.log(toastError); }
  } catch (e) {
    if (jobFolder && !manifestCreated) {
      try { jobFolder.setTrashed(true); } catch (cleanupError) { Logger.log(cleanupError); }
    }
    if (jobId && !manifestCreated && scriptProperties.getProperty('QUOTE_EXPORT_STATUS_SHEET_NAME')) {
      try { recordQuoteExportStatus_(jobId, 'FAILED', e.message || String(e), ''); } catch (statusError) { Logger.log(statusError); }
    }
    Logger.log('Quote PDF export failed: ' + e.toString());
    SpreadsheetApp.getUi().alert('❌ ส่งออก/สร้างคิวไม่สำเร็จ: ' + e.message);
    return;
  } finally {
    lock.releaseLock();
  }
}

/**
 * ฟังก์ชันสำหรับเปิด Target Folder ผ่านหน้าต่างแจ้งเตือนพร้อมลิงก์
 */
function openTargetFolder() {
  openFolderUrl_('TARGET_FOLDER_ID', 'โฟลเดอร์เป้าหมาย (Target Folder)');
}

/**
 * ฟังก์ชันสำหรับเปิด Backup Folder ผ่านหน้าต่างแจ้งเตือนพร้อมลิงก์
 */
function openBackupFolder() {
  openFolderUrl_('BACKUP_FOLDER_ID', 'โฟลเดอร์สำรอง (Backup Folder)');
}

function openQuoteQueueFolder() {
  openFolderUrl_('QUOTE_EXPORT_QUEUE_FOLDER_ID', 'โฟลเดอร์คิว JPG');
}

/**
 * ฟังก์ชันกลางสำหรับสร้างลิงก์เปิด Google Drive Folder
 */
function openFolderUrl_(propertyKey, folderLabel) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const folderId = scriptProperties.getProperty(propertyKey);
  
  if (!folderId) {
    SpreadsheetApp.getUi().alert(`⚠️ ยังไม่ได้กำหนดค่า ${propertyKey} ใน Script Properties`);
    return;
  }
  
  try {
    const folder = DriveApp.getFolderById(folderId);
    const folderUrl = folder.getUrl();
    
    // สร้างหน้าต่าง HTML เล็กๆ เพื่อแสดงลิงก์ที่สามารถคลิกเปิดได้ทันที
    const htmlOutput = HtmlService.createHtmlOutput(
      `<div style="font-family: sans-serif; padding: 15px; text-align: center;">` +
      `  <h3>📁 ${folderLabel}</h3>` +
      `  <p>คลิกที่ปุ่มด้านล่างเพื่อเปิดโฟลเดอร์ใน Google Drive:</p>` +
      `  <a href="${folderUrl}" target="_blank" style="display: inline-block; background-color: #1a73e8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold; margin-top: 10px;">เปิดโฟลเดอร์</a>` +
      `</div>`
    ).setWidth(350).setHeight(180);
    
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, folderLabel);
  } catch (e) {
    SpreadsheetApp.getUi().alert(`❌ เกิดข้อผิดพลาดในการเข้าถึงโฟลเดอร์: ${e.message}`);
  }
}

/**
 * ฟังก์ชันช่วยแปลง Google Sheet เป็น PDF Blob โดยอิงตาม Print Area ที่ตั้งค่าไว้ในแต่ละชีต
 */
function getSheetAsPDFBlob_(spreadsheetId, sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?` +
    stringifyParameters_({
      exportFormat: 'pdf',
      format: 'pdf',
      size: 'A4',
      portrait: 'true',
      fitw: 'true',
      gridlines: 'false',
      printtitle: 'false',
      sheetnames: 'false',
      gid: sheetId
    });
    
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() === 200) {
    return response.getBlob();
  } else {
    throw new Error(`ไม่สามารถสร้าง PDF ได้ (Error Code: ${response.getResponseCode()})`);
  }
}

/**
 * ฟังก์ชันช่วยแปลง Object พารามิเตอร์เป็น Query String สำหรับ URL Fetch
 */
function stringifyParameters_(params) {
  return Object.keys(params)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
    .join('&');
}

function hasAllCustomerTypes_(sheetNames) {
  const required = ['หมูกระทะ', 'ชาบู', 'ร้านชำ', 'หมึกย่าง'];
  return required.every(function (name) { return sheetNames.includes(name); });
}

/** สร้างหรือเตรียมชีตบันทึกสถานะงาน */
function ensureQuoteExportStatusSheet_(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Job ID', 'เวลาสร้าง', 'อัปเดตล่าสุด', 'สถานะ', 'รายละเอียด', 'Manifest URL']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recordQuoteExportStatus_(jobId, status, detail, manifestUrl) {
  const props = PropertiesService.getScriptProperties();
  const statusSheetName = props.getProperty('QUOTE_EXPORT_STATUS_SHEET_NAME');
  if (!statusSheetName) throw new Error('ไม่ได้ตั้ง QUOTE_EXPORT_STATUS_SHEET_NAME');
  const sheet = ensureQuoteExportStatusSheet_(getQuoteSpreadsheet_(), statusSheetName);
  const rows = sheet.getDataRange().getValues();
  let rowNumber = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(jobId)) { rowNumber = i + 1; break; }
  }
  const now = new Date();
  if (!rowNumber) {
    rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, 6).setValues([[jobId, now, now, status, String(detail || '').slice(0, 2000), manifestUrl || '']]);
  } else {
    sheet.getRange(rowNumber, 3, 1, 3).setValues([[now, status, String(detail || '').slice(0, 2000)]]);
    if (manifestUrl) sheet.getRange(rowNumber, 6).setValue(manifestUrl);
  }
}

function setQuoteExportManifestUrl_(jobId, manifestUrl) {
  const sheetName = PropertiesService.getScriptProperties().getProperty('QUOTE_EXPORT_STATUS_SHEET_NAME');
  if (!sheetName) return;
  const sheet = ensureQuoteExportStatusSheet_(getQuoteSpreadsheet_(), sheetName);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(jobId)) {
      sheet.getRange(i + 1, 6).setValue(manifestUrl);
      return;
    }
  }
}

function getQuoteSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('QUOTE_EXPORT_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('ไม่ได้ตั้ง QUOTE_EXPORT_SPREADSHEET_ID; กรุณารัน setupQuoteImageExport() จากชีต');
}

/**
 * Web app callback สำหรับ PC agent; deploy web app เป็น Anyone แล้วใช้ token
 * ที่อยู่ใน Script Properties เพื่อป้องกันการเขียนสถานะโดยบุคคลอื่น.
 */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents || '{}');
  } catch (err) {
    return quoteJsonResponse_({ status: 'error', message: 'invalid JSON' });
  }
  if (!body || body.action !== 'quoteExportStatus') {
    return quoteJsonResponse_({ status: 'error', message: 'unsupported action' });
  }

  const expectedToken = PropertiesService.getScriptProperties().getProperty('QUOTE_EXPORT_STATUS_TOKEN') || '';
  if (!expectedToken || String(body.token || '') !== expectedToken) {
    console.error('Rejected quote export status callback: invalid token');
    return quoteJsonResponse_({ status: 'error', message: 'unauthorized' });
  }
  const jobId = String(body.jobId || '').trim();
  const status = String(body.status || '');
  if (!jobId || !['PROCESSING', 'COMPLETED', 'FAILED'].includes(status)) {
    return quoteJsonResponse_({ status: 'error', message: 'invalid status payload' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return quoteJsonResponse_({ status: 'error', message: 'busy' });
  try {
    recordQuoteExportStatus_(jobId, status, String(body.detail || '').slice(0, 2000), '');
    return quoteJsonResponse_({ status: 'ok' });
  } catch (err) {
    console.error('Quote export callback failed: ' + err.toString());
    return quoteJsonResponse_({ status: 'error', message: 'status update failed' });
  } finally {
    lock.releaseLock();
  }
}

function quoteJsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}


