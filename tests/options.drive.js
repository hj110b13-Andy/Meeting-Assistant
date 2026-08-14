/**
 * 設定頁的行為測試。
 *
 * 驗的是**存進去之後讀不讀得回來**這條來回 —— 使用者回報「名字與摘要
 * 間隔存了沒記錄下來」，而設定頁在這之前一項測試都沒有，
 * 這正是它能溜過去的原因。
 */
const out = document.createElement('pre');
out.id = 'testout';
document.body.appendChild(out);

const results = [];
const check = (name, cond, detail = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  →  ${detail}`}`);

const $$ = (id) => document.getElementById(id);
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
try {
  // options.js 尾端會呼叫 load()，它是非同步的，先讓它跑完
  await settle(); await settle();

  // ── 初始狀態：空白設定時欄位要有預設值，不能是 undefined ────────
  check('摘要段數載入了預設值', $$('summaryEverySegments').value === '8', $$('summaryEverySegments').value);
  check('摘要秒數是毫秒換算來的（300000ms → 300s）',
    $$('summaryEverySeconds').value === '300', $$('summaryEverySeconds').value);

  // ── 存設定 ────────────────────────────────────────────────────
  $$('myNames').value = '小陳, Ken';
  $$('notes').value = '我負責金流後端。';
  $$('summaryEverySegments').value = '5';
  $$('summaryEverySeconds').value = '180';
  $$('save').click();
  await settle(); await settle();

  check('按下儲存後有顯示確認', $$('saved').textContent.includes('已儲存'), $$('saved').textContent);

  const stored = window.__storage.settings;
  check('名字真的寫進 storage', stored?.myNames === '小陳, Ken', JSON.stringify(stored?.myNames));
  check('背景筆記真的寫進 storage', stored?.notes === '我負責金流後端。', JSON.stringify(stored?.notes));
  check('摘要段數真的寫進 storage', stored?.summaryEverySegments === 5, String(stored?.summaryEverySegments));
  check('摘要秒數換算回毫秒才存', stored?.summaryEveryMs === 180000, String(stored?.summaryEveryMs));

  // ── 關掉再打開：值要回來 ──────────────────────────────────────
  // 這是使用者實際回報的症狀。清空欄位再跑一次 load()，模擬重開設定頁。
  $$('myNames').value = '';
  $$('notes').value = '';
  $$('summaryEverySegments').value = '';
  $$('summaryEverySeconds').value = '';
  await load();
  await settle();

  check('重開設定頁後名字回來了', $$('myNames').value === '小陳, Ken', `「${$$('myNames').value}」`);
  check('重開設定頁後背景筆記回來了', $$('notes').value === '我負責金流後端。', `「${$$('notes').value}」`);
  check('重開設定頁後摘要段數回來了', $$('summaryEverySegments').value === '5', $$('summaryEverySegments').value);
  check('重開設定頁後摘要秒數回來了', $$('summaryEverySeconds').value === '180', $$('summaryEverySeconds').value);

  // ── 夾範圍：亂填不能存進一個會讓摘要再也不觸發的數字 ────────────
  $$('summaryEverySegments').value = '999';
  $$('summaryEverySeconds').value = '1';
  $$('save').click();
  await settle(); await settle();
  check('段數上限夾在 50', window.__storage.settings?.summaryEverySegments === 50,
    String(window.__storage.settings?.summaryEverySegments));
  check('秒數下限夾在 15', window.__storage.settings?.summaryEveryMs === 15000,
    String(window.__storage.settings?.summaryEveryMs));

  // 空白要回到預設值，而不是存成 0（0 會讓摘要每兩句話就跑一次）
  $$('summaryEverySegments').value = '';
  $$('summaryEverySeconds').value = '';
  $$('save').click();
  await settle(); await settle();
  check('空白時回到預設段數 8', window.__storage.settings?.summaryEverySegments === 8,
    String(window.__storage.settings?.summaryEverySegments));
  check('空白時回到預設秒數 300', window.__storage.settings?.summaryEveryMs === 300000,
    String(window.__storage.settings?.summaryEveryMs));

  // ── 一顆按鈕要把「金鑰」與「其他設定」一起存下去 ────────────────
  // 這是使用者實際踩到的坑：原本金鑰與設定各有一顆儲存鍵，而金鑰那塊在
  // 頁面最上方，所以「儲存金鑰」是最先遇到的按鈕 —— 按到它，名字與摘要
  // 間隔就不會被存，畫面上卻還是出現綠色的「已儲存 ✓」。
  check('頁面上只有一顆儲存按鈕',
    document.querySelectorAll('button').length ===
      document.querySelectorAll('button[type="button"]').length + 1,
    [...document.querySelectorAll('button')].map((b) => b.textContent).join(' / '));

  $$('myNames').value = '王大明';
  $$('summaryEverySeconds').value = '240';
  $$('groq').value = 'gsk_FAKEoptionspagetestkey000000';
  $$('save').click();
  await settle(); await settle(); await settle();

  check('同一次儲存就把金鑰寫進去了',
    window.__storage.cloudKeys?.groq === 'gsk_FAKEoptionspagetestkey000000',
    JSON.stringify(window.__storage.cloudKeys));
  check('同一次儲存也把名字寫進去了',
    window.__storage.settings?.myNames === '王大明', JSON.stringify(window.__storage.settings?.myNames));
  check('同一次儲存也把摘要間隔寫進去了',
    window.__storage.settings?.summaryEveryMs === 240000,
    String(window.__storage.settings?.summaryEveryMs));
  check('金鑰跟設定仍然分開存（匯出設定時不會夾帶金鑰）',
    window.__storage.settings?.groq === undefined && !!window.__storage.cloudKeys);

  // 確認訊息要逐項列出存了什麼，使用者才能當場核對
  check('確認訊息列出名字', $$('saved').textContent.includes('王大明'), $$('saved').textContent);
  check('確認訊息列出摘要設定', $$('saved').textContent.includes('240'), $$('saved').textContent);
  check('確認訊息列出金鑰把數', $$('saved').textContent.includes('金鑰'), $$('saved').textContent);

  // 存完清空是刻意的（這一頁會出現在螢幕分享裡），但清空看起來很像沒存成功
  check('存完後金鑰輸入框清空', $$('groq').value === '', `「${$$('groq').value}」`);
  check('所以欄位要自己說它存了哪一把',
    $$('groq').placeholder.includes('已儲存') && $$('groq').placeholder.includes('gsk_FAKE'),
    $$('groq').placeholder);
  check('而且不會洩漏完整金鑰',
    !$$('groq').placeholder.includes('optionspagetestkey'), $$('groq').placeholder);
  check('狀態文字也顯示已儲存', $$('groqState').textContent.includes('已儲存'), $$('groqState').textContent);

  // 留空 = 不修改，不能把已存的清掉
  $$('save').click();
  await settle(); await settle();
  check('金鑰欄位留空時不會把已存的金鑰洗掉',
    window.__storage.cloudKeys?.groq === 'gsk_FAKEoptionspagetestkey000000',
    JSON.stringify(window.__storage.cloudKeys));

  // ── 有未儲存的變更時要講出來 ──────────────────────────────────
  // 這一頁比一個螢幕長，很容易填完就直接關掉
  check('剛儲存完沒有未存變更的提示', $$('dirty').textContent === '', $$('dirty').textContent);
  $$('myNames').value = '改了但還沒存';
  $$('myNames').dispatchEvent(new Event('input'));
  check('改了之後會提示尚未儲存', $$('dirty').textContent.includes('還沒儲存'), $$('dirty').textContent);
  $$('save').click();
  await settle(); await settle();
  check('存完之後提示消失', $$('dirty').textContent === '', $$('dirty').textContent);

  // ── 測試按鈕測的是眼前那把 ────────────────────────────────────
  window.__tested.length = 0;
  $$('nvidia').value = 'nvapi-FAKEtypedbutnotsaved0000000';
  $$('testNim').click();
  await settle(); await settle();
  check('測試用的是輸入框裡當下那把（還沒儲存也能測）',
    window.__tested[0]?.key === 'nvapi-FAKEtypedbutnotsaved0000000', JSON.stringify(window.__tested[0]));

  window.__tested.length = 0;
  $$('nvidia').value = '';
  $$('testGroq').click();
  await settle(); await settle();
  check('輸入框空著時測已儲存的那把',
    window.__tested[0]?.key === 'gsk_FAKEoptionspagetestkey000000', JSON.stringify(window.__tested[0]));

  // ── 貼錯欄位要抓出來 ──────────────────────────────────────────
  $$('nvidia').value = 'gsk_FAKEwrongfieldonpurpose00000';
  $$('save').click();
  await settle(); await settle(); await settle();
  check('把 Groq 金鑰貼到 NVIDIA 欄位會被指出來',
    $$('keysCurrent').innerHTML.includes('貼錯欄位'), $$('keysCurrent').textContent.slice(-80));

  // ── 「目前實際存了什麼」的診斷 ────────────────────────────────
  // 它存在的理由是「畫面說已儲存但其實沒存」這種很難查的失敗，
  // 所以它自己一定要讀儲存層、而且不能洩漏金鑰。
  $$('myNames').value = '診斷用名字';
  $$('save').click();
  await settle(); await settle();
  $$('dumpState').click();
  await settle(); await settle();

  const dump = $$('dumpOut').textContent;
  check('診斷顯示存下來的名字', dump.includes('診斷用名字'), dump.slice(0, 120));
  check('診斷顯示摘要頻率', /至少 \d+ 段/.test(dump), dump.slice(0, 200));
  check('診斷顯示金鑰是遮罩過的', dump.includes('gsk_FAKE') && !dump.includes('optionspagetestkey'), dump);
  check('診斷講得出現在會走哪條路', dump.includes('逐字稿：'), dump);
  check('有 Groq 金鑰時說走雲端辨識', dump.includes('Groq 雲端辨識'), dump);

} catch (err) {
  results.push(`FAIL  測試中斷  →  ${err.stack || err}`);
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
out.textContent = results.join('\n') + '\n---\n'
  + (failed === 0 ? `全部 ${results.length} 項通過` : `${failed} 項失敗`);
})();
