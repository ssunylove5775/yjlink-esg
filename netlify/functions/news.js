/* ═══════════════════════════════════════════════════════════════════
   ESG 소식 자동 수집 (Netlify 무료 서버 기능)

   호출 주소 : /.netlify/functions/news
   하는 일   : 세 곳에서 최신 소식을 모아 JSON으로 돌려줍니다.
                 ① 환경일보 RSS              → «환경뉴스» 카드
                 ② 와이제이링크 보도자료       → «와이제이링크» 카드
                 ③ 와이제이링크 이벤트 게시판   → «사내 ESG 활동» 카드

   왜 필요한가요?
     브라우저는 보안상 다른 사이트의 글을 직접 못 읽습니다(CORS 차단).
     그래서 Netlify 서버가 대신 읽어와 전달합니다.

   돌려주는 모양
     { "esg":     [ {title, link, date, summary, section}, ... ],
       "company": [ {title, link, date, summary}, ... ],
       "event":   [ {title, link, date, summary}, ... ] }
     date 는 모두 «YYYY-MM-DD» 로 맞춰서 돌려줍니다.

   갱신 주기 : 1시간 (아래 CACHE_SECONDS). 숫자를 바꾸면 주기가 바뀝니다.
               예) 86400 = 하루 / 604800 = 일주일

   ⚠️ 와이제이링크 보도자료는 RSS가 막혀 있어 게시판 HTML을 직접 읽습니다.
      회사가 홈페이지를 개편하면 CSS 클래스명이 바뀌어 수집이 멈출 수 있습니다.
      그때는 아래 LIST_RE 와 parseBoard() 를 새 구조에 맞게 고쳐주세요.
      수집이 실패해도 화면은 «환경뉴스»만으로 정상 동작합니다.
   ═══════════════════════════════════════════════════════════════════ */

const FEEDS = [
  { section: '환경뉴스', url: 'https://www.hkbs.co.kr/rss/S1N1.xml' },
  { section: '환경플러스', url: 'https://www.hkbs.co.kr/rss/S1N2.xml' }
];

/* 와이제이링크 홈페이지 NEWS 메뉴의 하위 게시판들.
   구조가 모두 같아서 주소만 추가하면 수집 대상이 늘어납니다.
     · 보도자료(data)  → 언론사 기사로 링크됨
     · 이벤트(event)   → 사회공헌·봉사활동 등 ESG 사회(S) 활동
   ※ 공지사항(notice)·미디어(media)는 ESG 캠페인과 성격이 달라 제외했습니다. */
const BOARDS = [
  { key: 'company', name: '보도자료',      url: 'https://yjlink.com/bbs/board.php?bo_table=data',  max: 6 },
  { key: 'event',   name: '사내 ESG 활동', url: 'https://yjlink.com/bbs/board.php?bo_table=event', max: 6 }
];

const LIST_RE = /<li class="gall_li[\s\S]*?<\/li>/g;   // 게시글 한 덩어리

const MAX_ITEMS = 8;        // 환경뉴스 표시 건수
const CACHE_SECONDS = 3600; // 1시간마다 새로 가져옴

/** HTML 엔티티(&amp; &#034; 등) 풀기 */
function unescapeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 태그를 걷어내고 공백을 정리한 순수 텍스트 */
function stripTags(s) {
  return unescapeHtml(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** RSS 한 덩어리에서 특정 태그 내용 꺼내기 */
function pick(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = block.match(re);
  if (!m) return '';
  return stripTags(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

/** RSS XML → 기사 배열 */
function parseFeed(xml, section) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return blocks.map(function (b) {
    let summary = pick(b, 'description').replace(/^\[환경일보\]\s*/, '');
    if (summary.length > 110) summary = summary.slice(0, 110) + '…';
    const raw = pick(b, 'pubDate');
    return {
      title: pick(b, 'title'),
      link: pick(b, 'link'),
      date: (raw || '').slice(0, 10),
      summary: summary,
      section: section
    };
  }).filter(function (a) { return a.title && a.link; });
}

/** 게시판 HTML → 소식 배열 (보도자료·이벤트 공통) */
function parseBoard(htmlText, max) {
  const blocks = htmlText.match(LIST_RE) || [];
  const out = [];

  blocks.forEach(function (b) {
    // 첫 번째 <a> 는 썸네일(내용 없음), «VIEW MORE» 는 더보기 버튼이라 건너뜁니다
    let link = '', title = '';
    const re = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(b)) !== null) {
      const text = stripTags(m[2]);
      if (text && text.indexOf('VIEW MORE') === -1) {
        link = unescapeHtml(m[1]).trim();
        title = text;
        break;
      }
    }
    if (!title || !link) return;

    const c = b.match(/class="gall_content">([\s\S]*?)<\/div>/);
    let summary = c ? stripTags(c[1]).replace(/^본문내용\s*/, '').replace(/^내용\s*/, '') : '';
    if (summary.length > 110) summary = summary.slice(0, 110) + '…';

    // 게시판 날짜는 «MM-DD» 형태로만 들어 있습니다 (연도 없음)
    const d = b.match(/Date<\/b>[\s\S]*?>\s*(\d{2}-\d{2})/);

    out.push({ title: title, link: link, date: d ? d[1] : '', summary: summary });
  });

  return addYears(out).slice(0, max);
}

/** «MM-DD» 에 연도를 복원합니다.
    게시판 목록이 «최신순»이라는 성질을 이용합니다 —
    위에서 아래로 내려가다 날짜가 거꾸로 커지면 해가 하나 바뀐 것입니다.
    예) 12-30, 08-21, 01-15, 11-06 → 2025-12-30, 2025-08-21, 2025-01-15, 2024-11-06 */
function addYears(items) {
  const now = new Date();
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  let year = now.getFullYear();
  let prev = pad(now.getMonth() + 1) + '-' + pad(now.getDate());   // 오늘의 MM-DD

  items.forEach(function (a) {
    if (!a.date) return;
    if (a.date > prev) year--;    // 아직 오지 않은 날짜 → 지난 해의 글
    prev = a.date;
    a.date = year + '-' + a.date;
  });
  return items;
}

/** 주소 하나를 읽어 텍스트로 돌려줍니다. 실패하면 빈 문자열. */
async function getText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PuriCarbonDiet/1.0)' }
    });
    if (!res.ok) return '';
    return await res.text();
  } catch (e) {
    return '';
  }
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
    'Access-Control-Allow-Origin': '*'
  };

  let esg = [];
  const boards = {};

  // ① 환경일보 RSS
  try {
    const feedTexts = await Promise.all(FEEDS.map(function (f) { return getText(f.url); }));
    feedTexts.forEach(function (t, i) {
      if (t) esg = esg.concat(parseFeed(t, FEEDS[i].section));
    });
    esg = esg
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
      .slice(0, MAX_ITEMS);
  } catch (e) {
    esg = [];
  }

  // ② 와이제이링크 게시판들 (보도자료 · 이벤트)
  await Promise.all(BOARDS.map(async function (bd) {
    try {
      const t = await getText(bd.url);
      boards[bd.key] = t ? parseBoard(t, bd.max) : [];
    } catch (e) {
      boards[bd.key] = [];
    }
  }));

  // 어느 하나가 실패해도 200 + 빈 목록 → 화면은 나머지로 정상 동작합니다
  return {
    statusCode: 200,
    headers: headers,
    body: JSON.stringify({
      esg: esg,
      company: boards.company || [],
      event: boards.event || []
    })
  };
};
