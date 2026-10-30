# Price List Exporter: Google Sheets → PNG → GitHub Pages → LINE OA

## 1. เป้าหมาย
แปลงตารางราคาสินค้าใน Google Sheets เป็นไฟล์รูป PNG แล้วเผยแพร่ผ่าน HTTPS แบบ public
(ใครมีลิงก์ก็เปิดได้) เพื่อส่งรูปให้ลูกค้าทาง LINE OA

## 2. ข้อมูลต้นทาง
- Google Sheets 1 ไฟล์ มี 4 ชีต แยกตามประเภทลูกค้า
- แต่ละชีตพิมพ์ได้ 2 หน้า A4 รวมทั้งหมด 8 หน้า = 8 รูป

| ชีต | ชื่อไฟล์ | gid |
|---|---|---|
| หมูกระทะ | mookata | (ใส่ภายหลัง) |
| ชาบู | shabu | (ใส่ภายหลัง) |
| ร้านชำ | grocery | (ใส่ภายหลัง) |
| หมึกย่าง | squid | (ใส่ภายหลัง) |

- ไฟล์ผลลัพธ์: `{name}_{page}.png` เช่น `mookata_1.png`, `mookata_2.png`
- ตั้งชื่อไฟล์เป็นภาษาอังกฤษ เพื่อไม่ให้ URL มีปัญหา

## 3. เงื่อนไข
1. ห้ามมีค่า subscription ใช้เฉพาะบริการฟรี
2. ไม่จำเป็นต้องอัตโนมัติทั้งหมด แต่ต้องเก็บผลลัพธ์ของแต่ละขั้น (PDF, PNG) ไว้บน PC ได้
3. เน้นใช้งานง่าย: ดับเบิลคลิกไฟล์เดียวแล้วจบ และตั้งเวลาให้รันเองได้

## 4. Tech Stack
- Python 3.12+ ใช้ไลบรารี `requests` และ `pymupdf`
- Git + GitHub (repo แบบ public) + GitHub Pages (เผยแพร่จากโฟลเดอร์ `/docs` บน branch `main`)
- ตั้งเวลารัน: Windows Task Scheduler และ/หรือ GitHub Actions
- ระบบปฏิบัติการบนเครื่องผู้ใช้: Windows

## 5. Flow การทำงาน
1. `git pull --rebase --autostash` (ข้ามถ้าใช้ `--no-git`)
2. ดาวน์โหลด PDF ทีละชีตจาก
   `https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=pdf&gid={gid}&...`
   - พารามิเตอร์: size=A4, portrait=true, scale=2 (1=ปกติ, 2=พอดีความกว้าง,
     3=พอดีความสูง, 4=พอดีหน้า), gridlines=false, printtitle=false,
     sheetnames=false, pagenum=UNDEFINED, fzr=true, margin ทุกด้าน=0.3
   - ตรวจว่า HTTP 200 และไฟล์ขึ้นต้นด้วย `%PDF` ถ้าไม่ผ่านให้แสดง error ที่เข้าใจง่าย
   - เก็บ PDF ไว้ที่ `output_pdf/{name}.pdf` (เก็บบนเครื่องเท่านั้น ไม่ commit)
3. แปลง PDF เป็น PNG ด้วย PyMuPDF ที่ DPI=150 แล้วบันทึกไว้ที่ `docs/`
   - ลบไฟล์ `{name}_*.png` เก่าก่อนสร้างใหม่
   - เตือนเมื่อจำนวนหน้าไม่เท่ากับ 2
   - เตือนเมื่อไฟล์ใหญ่เกิน 10 MB
4. สร้างไฟล์ `docs/.nojekyll`
5. เขียนลิงก์ทั้งหมดลง `links.txt` ในรูปแบบ
   `{BASE_URL}/{file}?v={YYYYMMDDHHMM}` (เติม `?v=` เพื่อไม่ให้ LINE แสดงรูปเก่าที่จำไว้)
6. `git add docs` → ถ้าไม่มีอะไรเปลี่ยนให้ข้าม → ถ้ามีให้ commit แล้ว push
7. ถ้ามีชีตใดล้มเหลว ให้ทำชีตที่เหลือต่อ แล้วจบด้วย exit code 1

## 6. การตั้งค่า
- `SHEET_ID`: อ่านจาก environment variable เท่านั้น ห้าม hardcode ลงในไฟล์ที่ commit
- `SHEETS` (name → gid), `BASE_URL` (`https://USERNAME.github.io/price-list`),
  `DPI`, `EXPECTED_PAGES`, `PDF_OPTIONS`: เก็บเป็นค่าคงที่ไว้ด้านบนของสคริปต์
- CLI flag: `--no-git` = สร้างรูปอย่างเดียว ไม่ pull/push

## 7. โครงสร้างไฟล์
price-list/
├── AGENTS.md
├── export_sheets.py              # สคริปต์หลัก
├── requirements.txt              # requests, pymupdf
├── run.bat                       # ใช้บน PC (gitignored เพราะมี SHEET_ID)
├── .gitignore                    # output_pdf/, log.txt, links.txt, run.bat, __pycache__/
├── .github/workflows/export.yml
└── docs/                         # รูป PNG + .nojekyll (GitHub Pages)

## 8. run.bat (Windows)
- `chcp 65001`, `cd /d "%~dp0"`, `set SHEET_ID=...`, `set PYTHONIOENCODING=utf-8`
- ดับเบิลคลิกเอง: รันสคริปต์แล้วหยุดด้วย `pause`
- รันด้วยอาร์กิวเมนต์ `auto` (เรียกจาก Task Scheduler): เขียนผลต่อท้ายลง `log.txt` และไม่ pause

## 9. การตั้งเวลา
### A) Windows Task Scheduler
- เลือก Create Task (ไม่ใช่ Create Basic Task) → เลือก "Run only when user is logged on"
- Trigger: Daily 06:00
- Action: เรียก `run.bat` พร้อมอาร์กิวเมนต์ `auto` และตั้ง Start in = โฟลเดอร์โปรเจ็กต์
- ติ๊ก "Run task as soon as possible after a scheduled start is missed"
- เอาติ๊ก "Start only on AC power" ออก (สำหรับโน้ตบุ๊ก)

### B) GitHub Actions (แนะนำเป็นตัวหลัก เพราะไม่ต้องเปิดคอมไว้)
- Trigger: `schedule` cron `0 23 * * *` (= 06:00 เวลาไทย เพราะ cron ใช้ UTC) + `workflow_dispatch`
- `permissions: contents: write`, `concurrency: export-price-list`
- env: `TZ=Asia/Bangkok`, `SHEET_ID=${{ secrets.SHEET_ID }}`
- ขั้นตอน: checkout@v4 → setup-python@v5 (3.12) → pip install → ตั้ง git user เป็น
  github-actions[bot] → `python export_sheets.py`
- ข้อควรรู้: งานที่ตั้งเวลาไว้อาจรันช้า 5-30 นาที, ถ้า repo ไม่มีการเปลี่ยนแปลง 60 วัน
  GitHub จะปิดการตั้งเวลา, ถ้า push ได้ 403 ให้เปิด Workflow permissions = Read and write

## 10. การตั้งค่าที่ต้องทำเอง (ทำครั้งเดียว)
1. แชร์ Google Sheet แบบ Anyone with the link → Viewer และอย่าเก็บข้อมูลลับ
   (เช่น ต้นทุน) ไว้ในไฟล์เดียวกัน
2. ติดตั้ง Python (ติ๊ก Add to PATH) และ Git for Windows
3. สร้าง repo `price-list` แบบ Public → clone ลงเครื่อง → ตั้ง git user.name และ user.email
4. Settings → Pages → Deploy from branch → `main` + `/docs`
5. Settings → Secrets → Actions → เพิ่ม `SHEET_ID`

## 11. การใช้งานกับ LINE OA
- LINE รองรับรูป JPG/PNG ผ่าน HTTPS
  - originalContentUrl: ไม่เกิน 10 MB
  - previewImageUrl: ไม่เกิน 1 MB
- แชทเองผ่าน LINE OA Manager: ส่งรูปจากลิงก์ไม่ได้ ให้แนบไฟล์จากโฟลเดอร์ `docs/` แทน
- Messaging API / แชทบอท: ส่งเป็น image message โดยใช้ลิงก์ที่มี `?v=`

## 12. เกณฑ์ว่างานเสร็จ (Acceptance Criteria)
- [ ] รัน `run.bat` แล้วได้ PNG 8 ไฟล์ใน `docs/` และ PDF 4 ไฟล์ใน `output_pdf/`
- [ ] เปิด `https://USERNAME.github.io/price-list/mookata_1.png` ได้โดยไม่ต้องล็อกอิน
- [ ] ถ้าราคาไม่เปลี่ยน สคริปต์ไม่สร้าง commit ใหม่
- [ ] GitHub Actions กด Run workflow แล้วผ่าน และรันเองตามเวลาที่ตั้ง
- [ ] `links.txt` มีลิงก์ 8 รายการพร้อม `?v=`
- [ ] SHEET_ID ไม่หลุดขึ้นไปใน repo

## 13. งานที่เพิ่มได้ภายหลัง (Optional)
- สร้างรูปพรีวิวขนาดเล็กไม่เกิน 1 MB (เช่น `{name}_{page}_preview.jpg`) แยกจากรูปเต็ม
  เพื่อใช้กับ previewImageUrl ของ LINE
- กำหนดช่วงเซลล์ที่จะ export ต่อชีต (เช่น `range=A1:F80`) เพื่อคุมให้ได้ 2 หน้าพอดี
- สร้าง `docs/index.html` รวมลิงก์และรูปทั้งหมด

## 14. ข้อมูลที่ยังต้องกรอก
- SHEET_ID, ค่า gid ของทั้ง 4 ชีต, GitHub USERNAME
- ช่วงเซลล์ของแต่ละชีต (ถ้าต้องการคุมการแบ่งหน้าให้แม่นขึ้น)