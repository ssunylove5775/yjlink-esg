/* ═══════════════════════════════════════════════════════════════════
   ESG 소식 자동 수집 (Netlify 무료 서버 기능)

   호출 주소 : /.netlify/functions/news
   하는 일   : 두 곳에서 최신 소식을 모아 JSON으로 돌려줍니다.
                 ① 환경일보 RSS          → «환경뉴스» 카드
                 ② 와이제이링크 보도자료   → «와이제이링크 소식» 카드

   왜 필요한가요?
     브라우저는 보안상 다른 사이트의 글을 직접 못 읽습니다(CORS 차단).
     그래서 Netlify 서버가 대신 읽어와 전달합니다.

   돌려주는 모양
     { "esg": [ {title, link, date, summary, section}, ... ],
       "company": [ {title, link, date, summary}, ... ] }

   갱신 주기 : 1시간 (아래 CACHE_SECONDS). 숫자를 바꾸면 주기가 바뀝니다.
               예) 86400 = 하루 / 604800 = 일주일

   ⚠️ 와이제이링크 보도자료는 RSS가 막혀 있어 게시판 HTML을 직접 읽습니다.
      회사가 홈페이지를 개편하면 CSS 클래스명이 바뀌어 수집이 멈출 수 있습니다.
      그때는 아래 COMPANY.listRe / titleRe 를 새 구조에 맞게 고쳐주세요.
      수집이 실패해도 화면은 «환경뉴스»만으로 정상 동작합니다.
   ═══════════════════════════════════════════════════════════════════ */

const FEEDS = [
  { section: '환경뉴스', url: 'https://www.hkbs.co.kr/rss/S1N1.xml' },
  { section: '환경플러스', url: 'https://www.hkbs.co.kr/rss/S1N2.xml' }
];

const COMPANY = {
  name: '와이제이링크',
  url: 'https://yjlink.com/bbs/board.php?bo_table=data',
  listRe: /<li class="gall_li[\s\S]*?<\/li>/g,   // 게시글 한 덩어리
  max: 6
};

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

/** 와이제이링크 보도자료 게시판 HTML → 소식 배열
    게시글마다 «제목 링크»가 실제 언론사 기사로 연결돼 있습니다. */
function parseCompany(htmlText) {
  const blocks = htmlText.match(COMPANY.listRe) || [];
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

    // 날짜는 «MM-DD» 형태로만 들어 있습니다
    const d = b.match(/Date<\/b>[\s\S]*?>\s*(\d{2}-\d{2})/);

    out.push({
      title: title,
      link: link,
      date: d ? d[1] : '',
      summary: summary || (COMPANY.name + ' 보도자료입니다.')
    });
  });

  return out.slice(0, COMPANY.max);
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
  let company = [];

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

  try {
    const t = await getText(COMPANY.url);
    if (t) company = parseCompany(t);
  } catch (e) {
    company = [];
  }

  // 둘 다 실패해도 200 + 빈 목록 → 화면은 기존 안내 카드로 대체됩니다
  return {
    statusCode: 200,
    headers: headers,
    body: JSON.stringify({ esg: esg, company: company })
  };
};
