/* ═══════════════════════════════════════════════════════════════════
   환경일보 최신 기사 가져오기 (Netlify 무료 서버 기능)

   호출 주소 : /.netlify/functions/news
   하는 일   : 환경일보 RSS를 읽어 최신 기사 목록을 JSON으로 돌려줍니다.

   왜 필요한가요?
     브라우저는 보안상 다른 사이트의 RSS를 직접 못 읽습니다(CORS 차단).
     그래서 Netlify 서버가 대신 읽어와 전달합니다.

   갱신 주기 : 1시간 (아래 max-age=3600 초). 숫자를 바꾸면 주기가 바뀝니다.
               예) 86400 = 하루 / 604800 = 일주일

   다른 언론사로 바꾸려면 FEEDS 의 주소만 교체하세요.
   ═══════════════════════════════════════════════════════════════════ */

const FEEDS = [
  { section: '환경뉴스', url: 'https://www.hkbs.co.kr/rss/S1N1.xml' },
  { section: '환경플러스', url: 'https://www.hkbs.co.kr/rss/S1N2.xml' }
];

const MAX_ITEMS = 8;        // 화면에 보여줄 기사 수
const CACHE_SECONDS = 3600; // 1시간마다 새로 가져옴

/** RSS 한 덩어리에서 특정 태그 내용 꺼내기 */
function pick(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')  // CDATA 벗기기
    .replace(/<[^>]+>/g, '')                        // 태그 제거
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
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
      date: (raw || '').slice(0, 10),   // 2026-08-12
      summary: summary,
      section: section
    };
  }).filter(function (a) { return a.title && a.link; });
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const results = await Promise.all(FEEDS.map(async function (f) {
      try {
        const res = await fetch(f.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PuriCarbonDiet/1.0)' }
        });
        if (!res.ok) return [];
        return parseFeed(await res.text(), f.section);
      } catch (e) {
        return [];
      }
    }));

    // 최신순 정렬 후 상위 N건만
    const all = [].concat.apply([], results)
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
      .slice(0, MAX_ITEMS);

    return { statusCode: 200, headers: headers, body: JSON.stringify(all) };
  } catch (e) {
    // 실패해도 빈 배열을 돌려줍니다 → 화면은 기존 안내 카드로 대체됩니다
    return { statusCode: 200, headers: headers, body: '[]' };
  }
};
