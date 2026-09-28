'use strict';

/*
 * 美股晨析 —— 前端应用脚本(纯浏览器,无框架)。
 * 职责:注册 SW;拉取并渲染简报(canonical schema);月历卡(pick/nopick/fail 标记 + 折叠态持久化);
 * Web Push 订阅/退订。所有网络请求只走 server.js 暴露的 /api/* 路由。
 * 免责声明「AI 生成,仅供参考,不构成投资建议」由 index.html 页脚静态承载。
 */

(function () {
  /* ==================== 纯函数区(无 DOM 依赖,可在 node 下独立自测) ====================
     行情展示相关的字符串/几何计算全部放这里:SVG 折线图生成器 buildChartSVG 是纯函数,
     便于 node 断言;渲染进 DOM 的交互(chip 切换、指针悬停)在下方浏览器段落。 */

  // HTML 转义:数据虽来自自家 JSON,仍统一转义,杜绝意外注入
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  /* ==================== 术语解释组件(数据源:docs/glossary.md) ====================
     用户零金融背景,界面上凡是绕不开的金融概念都必须能点开看大白话解释。

     为什么把词条**内联**进 app.js,而不是运行时 fetch docs/glossary.md:
       ① 这是 PWA,sw.js 已经缓存 app.js;多一个网络请求就多一种「解释打不开」的失败模式,
          而离线时最需要解释的恰恰是已经缓存下来的页面。
       ② docs/ 不在 public/ 下,运行时读它得新开一个后端接口,为一份静态文本不值得。
       ③ 漂移风险用测试兜住:test/glossary-sync.test.js 重新解析 docs/glossary.md,
          与这里的 GLOSSARY 逐字对比,任何一边改了另一边没跟上都会红。
     所以 docs/glossary.md 仍然是唯一真相,这里只是它的一份被测试钉住的编译产物。 */

  const GLOSSARY = {
    "标普500": { term: "标普500", aliases: [],
      one: "美国最大的 500 家上市公司凑成的一个名单，通常用来代表「整个美国股市」。",
      why: "判断一只股票好不好，不能只看它涨没涨，要看它有没有跑得比这 500 家的平均水平快。平均水平就是这个。",
      use: "本 App 只研究这 500 家。所有「多赚/少赚」都是跟它比出来的。",
      myth: "它不是「500 家最好的公司」，只是「500 家最大的」。名单每年会换二十几家。" },
    "毛利润率": { term: "毛利润率", aliases: [],
      one: "公司每卖 100 块钱的东西，扣掉进货和生产成本之后还剩多少。",
      why: "剩得多，说明它的东西有竞争力、不用靠打折卖。开奶茶店一杯卖 20 块、原料成本 4 块，毛利润率就是 80%。",
      use: "这是我们测过的几千个指标里，唯一一个看起来有点用的方向 —— 但最后也没能证明它真能预测涨跌（见「统计显著」）。",
      myth: "毛利润率高不等于最后赚钱多。房租、工资、广告费还没扣。" },
    "股东权益": { term: "股东权益", aliases: [],
      one: "把公司所有东西卖掉、还完所有欠款之后，剩下的归股东的那部分。",
      why: "它是「这家公司自己有多少本钱」。用同样本钱赚得更多的公司，效率更高。",
      use: "",
      myth: "它不是股价，也不是公司市值。是账面上算出来的。" },
    "市值": { term: "市值", aliases: [],
      one: "股价 × 总股数 = 按现在的价格，买下整家公司要花多少钱。",
      why: "市值大的公司通常更稳、更容易买卖；小的波动大。",
      use: "",
      myth: "股价高不代表公司大。一股 500 块的小公司，可能比一股 30 块的大公司小得多。" },
    "超额收益": { term: "超额收益", aliases: ["比大盘多赚","少赚"],
      one: "你赚的钱，减去「什么都不挑、直接买整个市场」能赚的钱。",
      why: "这才是「挑股票这件事到底有没有价值」的唯一衡量。市场涨 20% 你赚 15%，虽然赚了，但其实不如不挑。",
      use: "本 App 所有成绩都按这个算，不看绝对涨跌。",
      myth: "赚钱 ≠ 有本事。牛市里随便买都赚。" },
    "回撤": { term: "回撤", aliases: [],
      one: "从最高点跌下来了多少。",
      why: "它衡量「你中途要忍受多难受」。同样一年赚 10%，中途最多跌 15% 和最多跌 50%，是完全不同的两件事 —— 后者大部分人会在半路上割肉离场。",
      use: "",
      myth: "回撤不是「亏了多少」。只要没卖，跌下去还可能涨回来。" },
    "换手率": { term: "换手率", aliases: [],
      one: "一年里你把手上的股票换掉了几遍。",
      why: "每换一次都要付钱（见「交易成本」）。换手 1800% 意思是一年换了 18 遍，手续费能把赚的全吃光。",
      use: "我们实测过 —— 本 App 原来每天重排名单，一年换 18 遍，扣掉成本后从「每年赚 9.6%」变成「赚 0.2%」。",
      myth: "" },
    "交易成本": { term: "交易成本", aliases: ["价差"],
      one: "买卖股票时看不见的损耗。除了手续费，还有「你想买的价格」和「别人愿意卖的价格」之间的差。",
      why: "这是纸上策略和真钱之间最常见的杀手。很多在电脑里能赚钱的方法，一算成本就一分不剩。",
      use: "本 App 所有回测都按 0 / 0.1% / 0.25% / 0.5% 四档分别报，不给「零成本」的漂亮数字。",
      myth: "「手续费才万分之几」——真正贵的是价差和大额下单时把价格推上去的那部分。" },
    "分位": { term: "分位", aliases: [],
      one: "「过去两年里有 86% 的时间它比现在贵」这句话，用行话说就是「两年分位 14%」。",
      why: "光说「跌了 40%」不知道算多算少，说「过去两年八成时间都比现在贵」就有参照了。",
      use: "界面上一律说人话版，这个词只在内部代码里出现。",
      myth: "" },
    "中位数": { term: "中位数", aliases: [],
      one: "把所有数从小到大排队，站正中间那个。",
      why: "比「平均数」抗极端值。10 个人里 9 个月薪 5 千、1 个月薪 100 万，平均 10 万（骗人），中位数 5 千（真实）。",
      use: "",
      myth: "" },
    "样本量": { term: "样本量", aliases: [],
      one: "你手上有多少条互相独立的观察记录。",
      why: "抛 3 次硬币全是正面，说明不了硬币有问题；抛 300 次全是正面就说明有问题了。判断一个选股方法好不好，同理。",
      use: "这是本 App 最大的硬伤 —— 12 年数据、按「持有一年」算只有约 12 条独立记录。要证明一个方法每年能多赚 2%，需要 254 年的数据。",
      myth: "" },
    "统计显著": { term: "统计显著", aliases: [],
      one: "结果好到不像是运气。",
      why: "一个方法在历史数据上赚了钱，可能是真有用，也可能纯属巧合。「显著」就是用数学判断这两者。",
      use: "我们试了 9000 多种选股方法，没有一种达到显著。而且试得越多，越容易碰巧撞到几个好看的 —— 所以我们用了专门抵消这个的算法。",
      myth: "「不显著」不等于「已证明没用」，也可能是数据不够多、测不出来。这两个必须分清。" },
    "幸存者偏差": { term: "幸存者偏差", aliases: [],
      one: "只统计活下来的，结论天生偏乐观。",
      why: "「创业成功率很高」——因为倒闭的公司没人采访。股票同理：过去十年有 150 多家公司被收购或摘牌下市，如果只统计现在还在名单上的 500 家，等于只看赢家。",
      use: "我们发现自己的回测有这个毛病（漏了 152 家），而且免费数据源补不回来 —— 已退市公司的历史股价查不到。所以我们把这条写进了已知缺陷，而不是假装没有。",
      myth: "" },
    "前视偏差": { term: "前视偏差", aliases: [],
      one: "算历史成绩时，不小心用了当时还不知道的信息。",
      why: "这是回测里最致命的错误。比如用 3 月才公布的财报去决定 1 月买什么 —— 电脑里赚翻了，真钱一分赚不到。",
      use: "我们实测过：把这道防线拆掉，同一个方法的成绩立刻从「多赚 5.5%」变成「多赚 9.9%」。那 4 个百分点是凭空变出来的。所以这道防线有专门的测试守着。",
      myth: "" },
    "过拟合": { term: "过拟合", aliases: [],
      one: "把巧合当规律。",
      why: "拿历史数据反复试，总能找到「过去十年百发百中」的规律，但它对未来毫无用处。就像找出「每次我穿蓝袜子球队就赢」。",
      use: "我们实测发现 —— 随便乱挑一组参数，效果比精心挑选的还好。这就是过拟合的铁证，所以我们不再优化参数。",
      myth: "" },
    "风险调整": { term: "风险调整", aliases: [],
      one: "把「靠承担更大风险赚到的钱」从成绩里扣掉。",
      why: "买波动大的股票，涨的时候赚更多，跌的时候亏更多。这不算本事，只是赌得更大。",
      use: "本 App 吃过两次亏 —— 有两个方法看着每年多赚 6%，扣掉风险后其实是亏的。现在所有成绩都必须扣完风险再报。",
      myth: "" },
    "Beta": { term: "Beta", aliases: ["跟大盘的联动程度"],
      one: "大盘涨 1%，这只股票通常涨多少。",
      why: "Beta 1.3 的意思是大盘涨 10% 它涨 13%、跌 10% 它跌 13%。这种股票在牛市里看着很厉害，但那是杠杆，不是眼光。",
      use: "",
      myth: "Beta 高不等于好。它只说明波动大。" },
    "分散": { term: "分散", aliases: [],
      one: "别把钱全押在一两只股票上。",
      why: "一只股票可能因为一个意外腰斩，20 只同时腰斩的概率极低。",
      use: "",
      myth: "买 20 只同行业的股票不叫分散 —— 它们会一起跌。" },
    "长期持有": { term: "长期持有", aliases: ["短期交易"],
      one: "长期 = 一年以上，看的是公司本身赚不赚钱；短期 = 几天到几周，看的是价格波动。",
      why: "这两件事的逻辑完全相反。同一个指标在一个月尺度上有效，在半年尺度上可能正好反过来 —— 我们实测确认了这一点。",
      use: "本 App 会分别写明未来约 1 个月、1 年和 3—5 年的主观方向，但最终行动仍按长期逻辑判断。1 个月展望不是精确买点、目标价或自动短线交易信号；以前回测到的高换手短期策略，手续费会吃光，所以仍不拿来交易。",
      myth: "" },
    "财报": { term: "财报", aliases: ["SEC"],
      one: "SEC 是美国的证监会。美国上市公司必须按季度、按年向它交财务报告，公开可查。",
      why: "这是唯一免费且权威的公司真实经营数据来源。我们所有公司数据都直接从它那里拉，不经过第三方。",
      use: "关键是用当时已经公布的版本 —— 财报有公布日期，我们只用那天之前已经公开的（见「前视偏差」）。",
      myth: "" },
    "指数成分股": { term: "指数成分股", aliases: [],
      one: "标普 500 名单里的那 500 家。名单会变 —— 每年有二十几家被换掉。",
      why: "算历史成绩时必须用「当时的名单」，不能用今天的。用今天的等于提前知道谁会被踢出去（见「幸存者偏差」）。",
      use: "",
      myth: "" },
    "免费 AI": { term: "免费 AI", aliases: [],
      one: "一个不用花钱的 AI，负责每天把轮到的几家公司从头查一遍。",
      why: "以前这份工作用的是要花钱的模型。现在换成免费的，省下来的钱不影响结论的质量要求 —— 查资料的次数、要两个来源对数字、给真实链接，这些规矩一条没少。",
      use: "它查到的每条结论都标着「免费 AI 研究」，跟以前花钱模型做的结论分开标记，方便分别看准不准。",
      myth: "免费不等于随便。免费额度有时要排队，排不上那天页面会明说「今天 AI 未运行」，不会硬编一份结论给你。" },
  };

  // 界面上的写法 → 词条键。docs/glossary.md 里没写、但用户会在界面上读到的同义写法放这里。
  const GLOSSARY_ALIASES = {
    '大盘': '标普500', '标普 500': '标普500', '标普500指数': '标普500', '标普 500 指数': '标普500',
    '美股大盘': '标普500', '整个市场': '标普500',
    '比大盘多赚': '超额收益', '比大盘少赚': '超额收益', '少赚': '超额收益',
    '跟大盘的联动程度': 'Beta', '价差': '交易成本', '手续费': '交易成本',
    '短期交易': '长期持有', '长期': '长期持有', 'SEC': '财报', '成分股': '指数成分股'
  };

  // 自动加解释链接的词。只放「用户真会在屏幕上读到、且普通人不一定懂」的。
  // 「分位」是特例:我们自己的文案已经不用它了,但 AI 生成的研究正文里仍会出现
  // (那些字来自 prompts/,不归前端改),所以留着让用户至少能点开问「这是啥」。
  // 长词排前面,避免「标普500」被「大盘」之类的短词抢先切开。
  const GLOSSARY_AUTOLINK = [
    '幸存者偏差', '前视偏差', '指数成分股', '交易成本', '毛利润率', '股东权益',
    '统计显著', '风险调整', '超额收益', '长期持有', '标普 500', '标普500',
    '样本量', '中位数', '换手率', '过拟合', '回撤', '市值', '分散', '大盘', '分位', 'Beta'
  ].sort(function (a, b) { return b.length - a.length; });

  // 词 → 词条(先查正名,再查别名)。查不到返回 null。
  function glossaryEntry(term) {
    const k = String(term == null ? '' : term).trim();
    if (!k) return null;
    if (GLOSSARY[k]) return GLOSSARY[k];
    const alias = GLOSSARY_ALIASES[k];
    if (alias && GLOSSARY[alias]) return GLOSSARY[alias];
    const keys = Object.keys(GLOSSARY);
    for (let i = 0; i < keys.length; i++) {
      if ((GLOSSARY[keys[i]].aliases || []).indexOf(k) > -1) return GLOSSARY[keys[i]];
    }
    return null;
  }

  // 可点击的术语。查不到词条 → 原样输出纯文本(绝不给一个点了没反应的按钮)。
  function glossaryTermHTML(term, label) {
    const e = glossaryEntry(term);
    const text = label != null ? label : term;
    if (!e) return esc(text);
    return '<button type="button" class="gl-term" data-term="' + esc(e.term) +
      '" aria-label="' + esc(text) + '：看大白话解释">' + esc(text) +
      '<span class="gl-mark" aria-hidden="true">?</span></button>';
  }

  // 弹窗正文(纯函数)。缺字段的小节整块跳过,不留空标题。
  function glossaryPopupHTML(term) {
    const e = glossaryEntry(term);
    if (!e) return '';
    const sec = function (title, body, cls) {
      if (!body) return '';
      return '<div class="gl-sec' + (cls ? ' ' + cls : '') + '">' +
        '<div class="gl-sec-title">' + esc(title) + '</div>' +
        '<p class="gl-sec-body">' + esc(body) + '</p></div>';
    };
    return '<div class="gl-pop">' +
      '<div class="gl-pop-head"><h3 class="gl-pop-title">' + esc(e.term) + '</h3>' +
      (e.aliases && e.aliases.length
        ? '<span class="gl-pop-alias">也叫:' + esc(e.aliases.join('、')) + '</span>' : '') +
      '</div>' +
      '<p class="gl-one">' + esc(e.one) + '</p>' +
      sec('为什么重要', e.why) +
      sec('这个 App 怎么用它', e.use) +
      sec('容易误会的地方', e.myth, 'gl-sec--myth') +
      '</div>';
  }

  // 全部词条一览(算法页底部「看不懂的词」)。
  // data-glossary="1":这一块的职责就是把行话摆出来解释,所以「人话锁」测试会整块跳过它。
  function glossaryListHTML() {
    const keys = Object.keys(GLOSSARY);
    if (!keys.length) return '';
    const chips = keys.map(function (k) { return glossaryTermHTML(k); }).join('');
    return '<details class="card gl-list" data-glossary="1">' +
      '<summary class="gl-list-sum">看不懂的词?点一下就有大白话解释</summary>' +
      '<p class="sec-body">这里每个词点开都是一句人话 + 容易误会的地方。完整版在 docs/glossary.md。</p>' +
      '<div class="gl-chips">' + chips + '</div></details>';
  }

  // 不能塞按钮的地方:按钮里再套按钮是非法 HTML;summary 里点一下会误触折叠;
  // a/option/select/textarea 同理。碰到这些标签就整段跳过,只在安全的文本节点里加链接。
  const GL_SKIP_TAGS = { button: 1, summary: 1, a: 1, option: 1, select: 1, textarea: 1, script: 1, style: 1 };

  // 给一段 HTML 里的术语加上「点一下看解释」。同一个词在同一段 HTML 里只标第一处
  // (每句都标会变成一片问号,反而没人点)。
  // 实现要点:先按标签切开,只改标签之间的文本节点 —— 绝不碰属性值,也就不会破坏 HTML。
  function glossaryLinkify(html) {
    const s = String(html == null ? '' : html);
    if (!s) return '';
    const parts = s.split(/(<[^>]*>)/);
    const used = Object.create(null);
    const skipDepth = Object.create(null);
    let skipping = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.charAt(0) === '<') {
        const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(p);
        if (m) {
          const name = m[2].toLowerCase();
          if (GL_SKIP_TAGS[name]) {
            if (m[1] === '/') {
              if (skipDepth[name] > 0) { skipDepth[name]--; skipping--; }
            } else if (!/\/>\s*$/.test(p)) {
              skipDepth[name] = (skipDepth[name] || 0) + 1; skipping++;
            }
          }
        }
        continue;
      }
      if (skipping > 0) continue;
      // 从左到右扫一遍原文,命中就整段替换并跳过已消费的字符 ——
      // 绝不回头去扫刚插进去的 HTML,否则后面的词可能被塞进 aria-label 里,把标签写坏。
      let outStr = '';
      let k = 0;
      while (k < p.length) {
        let matched = '';
        for (let j = 0; j < GLOSSARY_AUTOLINK.length; j++) {
          const w = GLOSSARY_AUTOLINK[j];
          if (p.substr(k, w.length) !== w) continue;
          const e = glossaryEntry(w);
          if (!e || used[e.term]) continue;
          matched = w;
          used[e.term] = true;
          outStr += glossaryTermHTML(e.term, w);
          break;
        }
        if (matched) { k += matched.length; } else { outStr += p.charAt(k); k += 1; }
      }
      parts[i] = outStr;
    }
    return parts.join('');
  }

  // 日期短格式 YYYY-MM-DD → MM-DD(x 轴标签用)
  function dateShort(d) {
    const s = String(d == null ? '' : d);
    return s.length >= 10 ? s.slice(5) : s;
  }

  // 数字千分位格式化(dp 位小数);非有限数返回空串
  function fmtNum(v, dp) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    const d = (dp == null) ? 2 : dp;
    const s = n.toFixed(d);
    const neg = s.charAt(0) === '-';
    const body = neg ? s.slice(1) : s;
    const parts = body.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  // 货币金额:$ 前缀 + 千分位
  function money(v, dp) {
    const s = fmtNum(v, dp == null ? 2 : dp);
    return s === '' ? '' : '$' + s;
  }

  // 带符号百分比(1 位小数):+3.2% / -8.5%
  function signedPct(v) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  }

  // 图表坐标保留 1 位小数,压缩 SVG 字符串体积
  function chartRound(n) { return Math.round(n * 10) / 10; }

  // 涨跌 delta:▲/▼ + 带符号百分比 + 状态色三通道(不靠颜色单独表意)
  function deltaHTML(v, cls) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    const up = n >= 0;
    const arrow = up ? '▲' : '▼';
    const sign = up ? '+' : ''; // 负数 toFixed 自带 '-'
    const dir = up ? 'delta-up' : 'delta-down';
    return '<span class="' + cls + ' ' + dir + '">' + arrow + ' ' + esc(sign + n.toFixed(1) + '%') + '</span>';
  }

  // 短期时点 view → 色点 class
  function timingDotClass(view) {
    if (view === '初现企稳') return 'dot-good';
    if (view === '可能仍有下探') return 'dot-warn';
    // 月度回顾 retro 的 timing.view 新四值(与日简报旧两值并存,旧简报不受影响)
    if (view === '仍可入场') return 'dot-good';
    if (view === '已修复,错过') return 'dot-none';
    if (view === '本就是陷阱') return 'dot-crit';
    if (view === '难以判断') return 'dot-none';
    return 'dot-none';
  }

  // 月度回顾 verdict → 色点 class(真机会=good / 价值陷阱=crit / 尚不明朗等=弱文)
  function verdictDotClass(verdict) {
    if (verdict === '真机会') return 'dot-good';
    if (verdict === '价值陷阱') return 'dot-crit';
    return 'dot-none';
  }

  // 月度回顾小节:低点日期/价格 · 自低点涨跌(delta 三通道)· verdict chip
  // retro:{low_date,low_price,drawdown_at_low_pct,since_low_pct,verdict};缺字段优雅跳过
  function buildRetroFactsHTML(retro) {
    if (!retro || typeof retro !== 'object') return '';
    const parts = [];
    const lp = Number(retro.low_price);
    const hasDate = retro.low_date != null && String(retro.low_date) !== '';
    if (hasDate || isFinite(lp)) {
      let s = '低点';
      if (hasDate) s += ' ' + esc(String(retro.low_date));
      if (isFinite(lp)) s += ' ' + esc(money(lp, 2));
      parts.push('<span class="retro-fact">' + s + '</span>');
    }
    if (isFinite(Number(retro.since_low_pct))) {
      parts.push('<span class="retro-fact">自低点 ' + deltaHTML(retro.since_low_pct, 'retro-delta') + '</span>');
    }
    if (retro.verdict) {
      parts.push('<span class="chip retro-verdict"><span class="dot ' + verdictDotClass(retro.verdict) +
        '"></span>' + esc(retro.verdict) + '</span>');
    }
    if (!parts.length) return '';
    return '<div class="retro-facts">' + parts.join('') + '</div>';
  }

  /* ---------- 走势图:纵轴「干净数字」区间 ---------- */

  // 依据数据跨度选一个干净刻度单位(1/2/5/10 × 10^k)
  function niceUnit(range) {
    if (!(range > 0)) return 1;
    const rough = range / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const nrm = rough / mag;
    let s;
    if (nrm < 1.5) s = 1; else if (nrm < 3) s = 2; else if (nrm < 7) s = 5; else s = 10;
    return s * mag;
  }

  // 把 [min,max] 向外取整到干净边界,返回 {lo,hi,dp,unit}
  function niceDomain(min, max) {
    let mn = Number(min), mx = Number(max);
    if (!isFinite(mn) || !isFinite(mx)) return { lo: 0, hi: 1, dp: 0, unit: 1 };
    if (mn === mx) { const p = Math.abs(mn) * 0.05 || 1; mn -= p; mx += p; }
    const unit = niceUnit(mx - mn);
    const lo = Math.floor(mn / unit) * unit;
    let hi = Math.ceil(mx / unit) * unit;
    if (hi === lo) hi = lo + unit;
    const dp = unit >= 1 ? 0 : (unit >= 0.1 ? 1 : 2);
    return { lo: lo, hi: hi, dp: dp, unit: unit };
  }

  // 计算折线图几何:清洗数据、纵轴区间、各点像素坐标、52 周低参考线
  // series: [{d:'YYYY-MM-DD', c:number}, …];opts:{width,height,showLow,lowValue}
  function computeChartLayout(series, opts) {
    opts = opts || {};
    const W = Math.max(160, Math.round(opts.width || 320));
    const H = Math.round(opts.height || 120);
    const padL = 8, padR = 48, padT = 14, padB = 18;
    const plotW = W - padL - padR;
    const baselineY = H - padB;
    const topY = padT;
    const plotH = baselineY - topY;

    const pts = [];
    (Array.isArray(series) ? series : []).forEach(function (s) {
      const c = s ? Number(s.c) : NaN;
      if (s && isFinite(c)) pts.push({ d: String(s.d == null ? '' : s.d), c: c });
    });
    const n = pts.length;

    let lo = 0, hi = 1, dp = 0;
    if (n) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) { const c = pts[i].c; if (c < mn) mn = c; if (c > mx) mx = c; }
      const nd = niceDomain(mn, mx);
      lo = nd.lo; hi = nd.hi; dp = nd.dp;
    }
    const span = (hi - lo) || 1;

    const points = pts.map(function (p, i) {
      const x = n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW;
      const y = baselineY - ((p.c - lo) / span) * plotH;
      return { i: i, d: p.d, c: p.c, x: chartRound(x), y: chartRound(y) };
    });

    // 52 周低参考线:仅在明确要求(1 年视图)且低点落在纵轴范围内时展示
    const lowV = Number(opts.lowValue);
    let low = { show: false, value: null, y: null, label: '' };
    if (opts.showLow && isFinite(lowV) && lowV >= lo && lowV <= hi) {
      low = {
        show: true, value: lowV,
        y: chartRound(baselineY - ((lowV - lo) / span) * plotH),
        label: '52周低 ' + money(lowV, 2)
      };
    }

    return {
      W: W, H: H, padL: padL, padR: padR, padT: padT, padB: padB,
      plotW: plotW, plotH: plotH, baselineY: baselineY, topY: topY,
      domainLo: lo, domainHi: hi, dp: dp,
      loLabel: money(lo, dp), hiLabel: money(hi, dp),
      points: points, low: low
    };
  }

  // 纯函数:根据 series 生成 SVG 折线图字符串(自适应宽、高约 120)
  // opts:{width,height,showLow,lowValue,uid}(uid 用于渐变 id 去重,多图共存不冲突)
  function buildChartSVG(series, opts) {
    opts = opts || {};
    const L = computeChartLayout(series, opts);
    const uid = String(opts.uid || 'c');
    const gradId = 'saArea-' + uid;
    const W = L.W, H = L.H, padL = L.padL, padR = L.padR, baselineY = L.baselineY, topY = L.topY;
    const rightX = W - padR + 5; // 右侧 min/max 标签起点 x
    const open = '<svg class="sa-chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="价格走势图">';
    const pts = L.points;
    if (!pts.length) return open + '</svg>';

    const first = pts[0], last = pts[pts.length - 1];
    let line = '';
    pts.forEach(function (p, i) { line += (i ? ' L ' : 'M ') + p.x + ' ' + p.y; });
    let area = 'M ' + first.x + ' ' + baselineY;
    pts.forEach(function (p) { area += ' L ' + p.x + ' ' + p.y; });
    area += ' L ' + last.x + ' ' + baselineY + ' Z';

    const out = [open];
    out.push('<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop class="sa-stop-top" offset="0"/><stop class="sa-stop-bot" offset="1"/></linearGradient></defs>');
    // 纵轴仅上下两条发丝网格线
    out.push('<line class="sa-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + topY + '" y2="' + topY + '" vector-effect="non-scaling-stroke"/>');
    out.push('<line class="sa-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + baselineY + '" y2="' + baselineY + '" vector-effect="non-scaling-stroke"/>');
    // 线下渐隐面积
    out.push('<path class="sa-area" d="' + area + '" fill="url(#' + gradId + ')"/>');
    // 52 周低参考线 + 右侧小标
    if (L.low.show) {
      out.push('<line class="sa-refline" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + L.low.y + '" y2="' + L.low.y + '" vector-effect="non-scaling-stroke"/>');
      out.push('<text class="sa-axis sa-reflabel" x="' + (W - padR - 4) + '" y="' + (L.low.y - 4) + '" text-anchor="end">' + esc(L.low.label) + '</text>');
    }
    // 折线
    out.push('<path class="sa-line" d="' + line + '" fill="none" vector-effect="non-scaling-stroke"/>');
    // 悬停十字线(初始隐藏)
    out.push('<line class="sa-cross" x1="0" x2="0" y1="' + topY + '" y2="' + baselineY + '" visibility="hidden" vector-effect="non-scaling-stroke"/>');
    // 末点:面色环 + 实心圆
    out.push('<circle class="sa-dot-halo" cx="' + last.x + '" cy="' + last.y + '" r="6.5"/>');
    out.push('<circle class="sa-dot" cx="' + last.x + '" cy="' + last.y + '" r="4.5"/>');
    // 悬停放大圆点(初始隐藏,置于最上层)
    out.push('<circle class="sa-hover" cx="0" cy="0" r="4.5" visibility="hidden"/>');
    // 轴标签:max/min(右侧)+ 首尾日期(底部两角)
    out.push('<text class="sa-axis" x="' + rightX + '" y="' + topY + '" text-anchor="start" dominant-baseline="middle">' + esc(L.hiLabel) + '</text>');
    out.push('<text class="sa-axis" x="' + rightX + '" y="' + baselineY + '" text-anchor="start" dominant-baseline="middle">' + esc(L.loLabel) + '</text>');
    out.push('<text class="sa-axis" x="' + padL + '" y="' + (H - 4) + '" text-anchor="start">' + esc(dateShort(first.d)) + '</text>');
    out.push('<text class="sa-axis" x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(dateShort(last.d)) + '</text>');
    out.push('</svg>');
    return out.join('');
  }

  /* ---------- 行情卡片各块的 HTML 生成(纯字符串,交互在下方浏览器段落挂载) ---------- */

  function statTile(label, valueHTML, sub) {
    return '<div class="stat">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value' + (sub ? ' stat-value--sub' : '') + '">' + valueHTML + '</div></div>';
  }

  // 统计行:现价(+当日 delta)/ 距 52 周高点 / 高于 52 周低点
  function buildStatRowHTML(md) {
    if (!md || typeof md !== 'object') return '';
    const price = Number(md.price);
    if (!isFinite(price)) return '';
    const priceHTML = esc(money(price, 2)) + deltaHTML(md.changeDayPct, 'stat-delta');
    const tiles = [statTile('现价', priceHTML, false)];
    if (isFinite(Number(md.drawdownFromHighPct))) {
      tiles.push(statTile('距 52 周高点', esc(signedPct(md.drawdownFromHighPct)), true));
    }
    if (isFinite(Number(md.aboveLowPct))) {
      tiles.push(statTile('高于 52 周低点', esc(signedPct(md.aboveLowPct)), true));
    }
    return '<div class="stat-row">' + tiles.join('') + '</div>';
  }

  // 走势图外壳(range 芯片 + 变化率行 + 空 plot 容器);SVG 由 wireChart 填充
  function buildChartBlockHTML(md, uid) {
    if (!md || typeof md !== 'object') return '';
    const has1m = Array.isArray(md.series1m) && md.series1m.length;
    const has1y = Array.isArray(md.series1y) && md.series1y.length;
    if (!has1m && !has1y) return '';
    const chg = deltaHTML(md.change1mPct, 'chart-delta');
    const chgLine = chg ? '<span class="chart-change">过去 1 个月实际涨跌（历史） ' + chg + '</span>' : '';
    const syn = md.source === 'synthetic'
      ? '<span class="chart-syn"><span class="dot dot-warn"></span>示意数据</span>' : '';
    const top = (chgLine || syn) ? '<div class="chart-top">' + chgLine + syn + '</div>' : '';
    return '<div class="chart-block" data-uid="' + esc(uid) + '">' +
      top +
      '<div class="chart-chips" role="tablist">' +
        '<button class="chart-chip" type="button" role="tab" data-range="1m">过去1个月行情</button>' +
        '<button class="chart-chip" type="button" role="tab" data-range="1y">近1年</button>' +
      '</div>' +
      '<div class="chart-plot"><div class="chart-tip" hidden></div></div>' +
    '</div>';
  }

  /* ---------- 后端**代码模板**文案的展示层补丁(2026-07-30) ----------
     brief.market_summary 这类字符串是 tools/research.js 用固定模板拼出来的
     (不是 AI 写的自由文本),里面还留着「量化低位分/深挖」这些内部说法,而前端会原样显示。
     实测 2026-07-30 首页「市场概览」那段就是:
       「…全市场量化低位扫描…当前量化低位分最高…仍需基本面深挖确认。」

     真正的修法在 tools/research.js,但那不在前端这次改动的范围里。这里做的是
     **只换名词、不改句子结构**的展示层补丁,只对「代码生成」的字段用;
     **绝不对 AI 自由文本用**(thesis / evidence_log / decision 等一律原样显示——
     擅自改写模型说过的话是另一种不诚实)。后端改好后,这一段连同它的测试一起删掉。 */
  /* 顺序有讲究:长词必须排在它的子串前面,否则会互相吃掉。
     「不建议买」含子串「建议买」——先用一个不可能出现在正文里的哨兵占位,
     等「建议买」换完再换回来(不用正则 lookbehind,老 Safari 不支持)。 */
  const PLAIN_SENTINEL = '\uE000';
  const BACKEND_PLAIN = [
    ['量化低位扫描', '股价位置扫描'], ['量化低位分', '股价位置分'], ['量化低位', '股价位置'],
    ['低位分', '股价位置分'], ['建议度', '值得关注程度'], ['买入把握', '买入理由完整度'],
    ['深度分析', '深入研究'], ['深挖', '深入研究'], ['快评', '快速评估'],
    ['怀疑者', '挑毛病的 AI'], ['沿用', '继续使用'], ['门槛', '达标线'], ['口径', '算法'],
    // 以下三条给 brief.changes[].note 用(tools/research.js buildChanges 的 statusLabel 模板)
    ['不建议买', PLAIN_SENTINEL], ['不建议', PLAIN_SENTINEL],
    ['建议买', '值得关注'], ['建议等', '继续等待'],
    [PLAIN_SENTINEL, '不建议买'],
  ];
  function plainifyBackendCopy(text) {
    let s = String(text == null ? '' : text);
    if (!s) return '';
    BACKEND_PLAIN.forEach(function (p) { s = s.split(p[0]).join(p[1]); });
    return s;
  }

  /**
   * 清洗 AI 自由文本(ai_note)里的**套话开头**与**句中截断**。
   *
   * 2026-07-30:后端 `tools/research.js thesisOneLiner` 已经在**写入时**剥掉
   * 「结论为“错杀的便宜（buy）”。」这类前缀、并保证取完整句。但 `data/analyses.json`
   * 里的存量结论是旧代码写的,有 21 天有效期 —— 用户今天就会看到:
   *   「结论为“错杀的便宜（buy）”。未来3年以上,Broadridge有望依靠…约两位数调整后EPS…」
   *   （套话开头 + 在词中间被 … 砍断）
   * 等 21 天自然滚动是一种做法,但没必要:剥前缀与补句尾都是确定性变换,
   * 在**展示时**再做一遍,存量缓存立刻生效,且不改动模型写的实质内容。
   *
   * 只做两件事,都不改模型的观点:
   *   ① 去掉「结论为/结论:…（buy）。」这类零信息量前缀(它占掉了本该说「凭什么」的位置)
   *   ② 若被硬截在词中间(以 … 结尾且末尾不是标点),回退到最后一个标点处断
   * 行话不在此处翻译 —— 那是模型写的话,改写它是另一种不诚实;界面给这些词挂了可点开的解释。
   */
  function plainifyAiNote(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return '';
    // ① 剥套话前缀:结论为“错杀的便宜（buy）”。/ 结论:错杀的便宜(buy)。
    s = s.replace(/^结论(?:为|是)?\s*[:：]?\s*[“"「]?[^“”"」。]{0,20}[”"」]?\s*[（(]?\s*(?:buy|sell|hold|watch|avoid)?\s*[)）]?\s*[。.]?\s*/i, '');
    // ② 词中截断 → 回退到最后一个标点
    if (/[…]+$/.test(s)) {
      const body = s.replace(/[…]+$/, '');
      const lastPunct = Math.max(
        body.lastIndexOf('。'), body.lastIndexOf('；'), body.lastIndexOf('，'),
        body.lastIndexOf('、'), body.lastIndexOf(','), body.lastIndexOf(';'));
      // 只在能保住足够内容时才回退,否则宁可留着原样(不制造空句)
      if (lastPunct > Math.min(30, body.length * 0.4)) s = body.slice(0, lastPunct + 1) + '……';
    }
    return s;
  }

  // 短期时点判断:色点 + view + reasoning + 固定 caveat
  // entry.timing.view 是**封闭枚举**(prompt 里写死的那几个值),不是自由文本,
  // 所以可以在展示层安全地翻成人话。自由文本(thesis/evidence_log 等)一律原样显示,不改模型的话。
  const TIMING_VIEW_PLAIN = {
    '初现企稳': '看着刚开始止跌',
    '可能仍有下探': '可能还会再跌一段',
    '难以判断': '看不出来',
    '仍可入场': '现在进场还来得及',
    '已修复,错过': '已经涨回去了,错过了',
    '已修复，错过': '已经涨回去了,错过了',
    '本就是陷阱': '当初就是个坑'
  };
  function timingViewPlain(view) {
    const s = String(view == null ? '' : view).trim();
    return TIMING_VIEW_PLAIN[s] || s;
  }

  function buildTimingHTML(timing) {
    if (!timing || typeof timing !== 'object' || !timing.view) return '';
    const reason = timing.reasoning ? '<p class="timing-reason">' + esc(timing.reasoning) + '</p>' : '';
    return '<div class="timing">' +
      '<div class="timing-head"><span class="timing-lead">最近这阵子:</span>' +
      '<span class="dot ' + timingDotClass(timing.view) + '"></span>' +
      '<span class="timing-view">' + esc(timingViewPlain(timing.view)) + '</span></div>' +
      reason +
      '<p class="timing-caveat">几周到几个月最难判断；这里给的是带不确定性的方向判断，' +
      '不是保证、目标价或精确买点。</p>' +
    '</div>';
  }

  /* ---------- 通用小节 / 取值助手(纯字符串) ---------- */

  // 标准小节:标题 + 正文段;正文空则整块跳过(与旧 pick 卡内 sec 同构)
  function secHTML(title, body) {
    return body
      ? '<div class="sec"><div class="sec-title">' + esc(title) + '</div><p class="sec-body">' + esc(body) + '</p></div>'
      : '';
  }

  // 取首个非空(null/undefined/'' 视为空)候选值 —— 兼容后端字段命名差异
  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v != null && v !== '') return v;
    }
    return undefined;
  }

  // 取首个可解析为有限数的候选值;全无则 NaN
  function firstNum() {
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      if (a == null || a === '') continue;
      const n = Number(a);
      if (isFinite(n)) return n;
    }
    return NaN;
  }

  // 2026-07-28 起「胜率」不再对用户展示,格式化函数一并移除。
  // 原因(事实核查):那个百分比只统计了 performance.json 里 155 条中的 34 条;
  // 「胜」的定义是「股价涨了」而不是「跑赢标普 500」,涨市里会机械地趋近 100%;
  // 34 条里多数来自把门槛从 7 降到 6 当天、用已知走势补记的历史日期(事后诸葛亮);
  // 该数 6 天内从 36.67% 跳到 97.06%。样本够之前只展示样本进度,不展示任何胜率百分比。

  // 判断结论 → 色点 class(判断正确=good / 判断错误=crit / 尚早等=弱文);兼容近义词
  function assessDot(s) {
    const t = String(s == null ? '' : s);
    if (t === '判断正确' || /正确|盈利|成功|跑赢/.test(t)) return 'dot-good';
    if (t === '判断错误' || /错误|亏损|失败|跑输/.test(t)) return 'dot-crit';
    return 'dot-none';
  }

  /* ---------- 量化评分条(data-viz;数据取自 leaderboard row,字段名容错)---------- */

  // 2 年分位 → 档位标签(分位越低越便宜)
  function pctileLabel(p) {
    const n = Number(p);
    if (!isFinite(n)) return '';
    if (n <= 30) return '低';
    if (n <= 70) return '中';
    return '高';
  }

  // 顺序条:左 label(弱文)+ 轨道(填充 accent,宽=widthPct%)+ 右数值(文字色)
  function qSeqBar(label, widthPct, valText) {
    let w = Number(widthPct);
    if (!isFinite(w)) w = 0;
    w = Math.max(0, Math.min(100, w));
    return '<div class="qbar">' +
      '<span class="qbar-label">' + esc(label) + '</span>' +
      '<div class="qbar-track"><i class="qbar-fill" style="width:' + w + '%"></i></div>' +
      '<span class="qbar-val">' + esc(valText) + '</span>' +
    '</div>';
  }

  // 发散条:以中线为原点,正向右 / 负向左(方向=图形通道,符号=文字通道);填充仍用 accent,不染数据色
  function qDivBar(label, value, valText) {
    const v = Number(value);
    const pos = isFinite(v) ? v >= 0 : true;
    const mag = isFinite(v) ? Math.min(50, Math.abs(v) * 1.5) : 0;
    const side = pos ? 'left:50%' : 'right:50%';
    const dirCls = pos ? 'qbar-fill--pos' : 'qbar-fill--neg';
    return '<div class="qbar">' +
      '<span class="qbar-label">' + esc(label) + '</span>' +
      '<div class="qbar-track qbar-track--div"><span class="qbar-zero"></span>' +
        '<i class="qbar-fill ' + dirCls + '" style="' + side + ';width:' + mag + '%"></i></div>' +
      '<span class="qbar-val">' + esc(valText) + '</span>' +
    '</div>';
  }

  // 量化评分条组件:顶部综合低位分(大数字 + band 色点 + band 文字)+ 至多 4 条数据条。
  // 4 条:①2年价格分位(条=100-分位,越满越便宜)②距52周高回撤 ③近1月动量(发散)④相对200日线(发散)。
  // row 缺失或全部字段无效 → 返回空串(优雅跳过);逐条缺字段跳过。
  function quantBarsHTML(row) {
    if (!row || typeof row !== 'object') return '';
    const scoreN = firstNum(row.quant_score, row.score);
    const pct = firstNum(row.pctileIn2y, row.pctile2y, row.pctileIn2Y);
    const dd = firstNum(row.drawdownFromHighPct, row.drawdown_from_high_pct);
    const mom = firstNum(row.ret1mPct, row.momentum1m, row.change1mPct, row.mom1mPct);
    const vs200 = firstNum(row.vs200dPct, row.vs200d);
    const anyBar = isFinite(pct) || isFinite(dd) || isFinite(mom) || isFinite(vs200);
    if (!anyBar && !isFinite(scoreN) && !row.band) return '';

    let head = '';
    const hp = [];
    if (isFinite(scoreN)) hp.push('<span class="qbars-score">股价位置分 ' + esc(Math.round(scoreN)) + '</span>');
    if (row.band) {
      const bm = bandMeta(row.band);
      hp.push('<span class="qbars-band"><span class="dot ' + bm.dot + '"></span>' + esc(bm.label) + '</span>');
    }
    if (hp.length) head = '<div class="qbars-head">' + hp.join('') + '</div>';

    // 每条都说人话:左边是「问的什么问题」,右边是「答案意味着什么」,不给行话缩写。
    const bars = [];
    if (isFinite(pct)) {
      const cheaperPct = Math.max(0, Math.min(100, Math.round(100 - pct)));
      bars.push(qSeqBar('跟自己过去两年比', 100 - pct,
        '有 ' + cheaperPct + '% 的时间它比现在贵'));
    }
    if (isFinite(dd)) {
      bars.push(qSeqBar('比一年里最高价低', Math.min(100, Math.abs(dd)), signedPct(dd)));
    }
    if (isFinite(mom)) {
      bars.push(qDivBar('过去一个月实际涨跌（历史）', mom, signedPct(mom)));
    }
    if (isFinite(vs200)) {
      bars.push(qDivBar('比大半年平均价', vs200, signedPct(vs200)));
    }
    const list = bars.length ? '<div class="qbars-list">' + bars.join('') + '</div>' : '';
    const hint = isFinite(pct) ? '<p class="qbars-hint">条越满,说明现在的股价越靠近它自己这两年的低处</p>' : '';
    if (!head && !list) return '';
    return '<div class="qbars">' + head + list + hint + '</div>';
  }

  /* ---------- 评分分解面板(row.score_parts 加权贡献分;缺失整块跳过)---------- */

  // 因子顺序与中文名(与后端评分口径一致):cheapVsHist / drawdown / stabilize / belowTrend / riskPenalty。
  // weightKey/dflt 供「评分方法」按 leaderboard.weights 动态显示权重百分比(缺权重时回退默认值)。
  const SCORE_PART_DEFS = [
    { key: 'cheapVsHist', label: '跟自己过去两年比,现在算便宜吗', weightKey: 'cheapVsHist', dflt: 30 },
    { key: 'drawdown', label: '比一年里最高价低了多少', weightKey: 'drawdown', dflt: 25 },
    // 2026-07-30 v2.6:权重已归零(定义即「最近已经涨了」,造成系统性追高)。dflt 同步改 0,
    // 否则老榜单缺 weights 时会回退成 20%,把已废弃的口径显示给用户。
    { key: 'stabilize', label: '最近有没有止跌（已停用）', weightKey: 'stabilize', dflt: 0 },
    { key: 'belowTrend', label: '有没有跌破大半年的平均价', weightKey: 'belowTrend', dflt: 15 },
    { key: 'riskPenalty', label: '涨跌太剧烈要扣分', weightKey: 'riskPenalty', dflt: 10 }
  ];

  // 评分方法说明(details 可展开看全文);权重百分比从 leaderboard.weights 动态读,缺失回退默认。
  function scoreMethodNoteHTML(weights) {
    const w = (weights && typeof weights === 'object') ? weights : {};
    function pc(k, dflt) {
      const v = Number(w[k]);
      return isFinite(v) ? Math.round(v * 100) : dflt;
    }
    const txt = '「股价位置分」怎么算:把 500 只股票放在一起横向比,' +
      '跟自己过去两年比便宜占 ' + pc('cheapVsHist', 30) + '%、' +
      '比一年最高价低了多少占 ' + pc('drawdown', 25) + '%、' +
      '有没有跌破大半年平均价占 ' + pc('belowTrend', 19) + '%,' +
      '涨跌太剧烈再扣 ' + pc('riskPenalty', 10) + '%。' +
      // v2.6:这一条是用户投诉「都涨上来了才推荐给我」之后查出来并停掉的，必须写给用户看。
      '（2026-07-30 起停用了原来占 ' + pc('stabilize', 0) + '% 的「最近有没有止跌」这一项：' +
      '它算的其实是「最近已经涨了多少」，给它加分等于奖励已经反弹的股票，' +
      '结果就是等股票涨上来了才推荐给你。停用当天实测：原来推荐名单里的股票平均一个月已经涨了 15%，' +
      '而全部 500 只的平均只有 2%。停用后这个数降到 1%，跟大盘持平。' +
      '要说清楚的是：这个改动**不会**让它变得能预测涨跌——它只是不再系统性地追高。）' +
      '它只回答一件事:『跟它自己以前比,现在的价格算不算低,而且没有失控』——完全不看公司好不好。' +
      // RUBRIC v2.5 §0.13:这五项彼此相关 0.85–0.94,是同一件事量了五遍,不得说成五个角度。
      '要说明的是:这五项实测彼此相关 0.85–0.94,其实是同一件事的五种写法,不是五个独立角度;' +
      '所以权重怎么调,排序基本不变。' +
      '榜单上的大数字:AI 已经完整研究过的股票显示 1–100「买入理由完整度」(不是胜率,也不是涨跌概率);' +
      '还没研究过的显示电脑估分(股价位置分 45% + 公司质量分 45% + 便宜程度分 10%,再打 6 折),最高只能到 59。' +
      // 口径同 RUBRIC v2.4 §3.1 第 3 条:名次必须分口径说,禁止混成一句混口径名次。
      // 这里只用「同口径比较」那一个(91 组权重全按严格口径打分,45/45/10 排 55),
      // 因为混口径表里那一行与其余 91 行可选域不同,对普通用户只会误导。
      // ⚠️ 测试禁止本串出现数字 56(那是被 RUBRIC 明令不得对用户使用的混口径名次)。
      '这套 45/45/10 的配比 2026-07-28 才第一次拿历史行情从头验过(验的时候把已经被踢出标普500的公司也补了回来):' +
      '没有一项结果达到统计显著(数据太少,好看难看都可能只是运气);用同一把尺子跟另外 90 组配比比,' +
      '它排第 55——既没被推翻,也谈不上最好;只用「股价位置」这一项时,3 年的超额收益已经归零。所以这套配比只是当前的默认值,' +
      '还在用真实的未来数据继续验证,不代表已被证明有效。' +
      // RUBRIC v2.4 §0:这两句必须成对出现,只写一句都是把话说过头。
      '说得更直白些:我们没有证据表明这个分数能帮你跑赢大盘——按本榜单前 20 名买入,往后一年跑赢标普500的比例只有 43%;' +
      '把分数分成五档,也看不出「档越高越容易跑赢」。但我们手上只有约 12 年数据,统计上只能查出「每年多赚 10 个百分点以上」这种大效果,' +
      '所以同样没有证据说它没用。请把它当成「今天先研究哪几只」的排队号码和一份读物,不要当作买卖信号。' +
      '榜单先排明确的值得关注/建议回避,再排继续等待和还没研究的;同一档里再按分数高低排。';
    return '<details class="sb-method"><summary class="sb-method-sum">这个分是怎么算出来的</summary>' +
      '<p class="sb-method-body">' + esc(txt) + '</p></details>';
  }

  // 评分分解面板(纯字符串):5 行加权贡献条(正=accent 蓝 / 负=crit 红,条长∝|贡献|/最大贡献)+
  // 右侧带符号文字分 + 合计行(≈ 低位分)+ 评分方法说明。
  // 数据取 row.score_parts;整块缺失或全部字段无效 → 返回空串(旧数据/回退模式优雅降级)。
  // weights 供方法说明动态权重;score 供合计行(缺则取各贡献之和)。
  function scoreBreakdownHTML(row, weights, score) {
    if (!row || typeof row !== 'object') return '';
    const parts = row.score_parts;
    if (!parts || typeof parts !== 'object') return '';
    const present = [];
    let maxMag = 0, sum = 0;
    SCORE_PART_DEFS.forEach(function (d) {
      const v = Number(parts[d.key]);
      if (!isFinite(v)) return;
      present.push({ def: d, v: v });
      sum += v;
      const m = Math.abs(v);
      if (m > maxMag) maxMag = m;
    });
    if (!present.length) return '';
    if (!(maxMag > 0)) maxMag = 1;
    const barRows = present.map(function (x) {
      const v = x.v;
      const neg = v < 0;
      const magPct = Math.max(0, Math.min(100, (Math.abs(v) / maxMag) * 100));
      const dirCls = neg ? 'sb-fill--neg' : 'sb-fill--pos';
      const valTxt = v > 0 ? '+' + v.toFixed(1) : v.toFixed(1); // 负数 toFixed 自带 '-';0 显示 0.0
      return '<div class="sb-row">' +
        '<span class="sb-label">' + esc(x.def.label) + '</span>' +
        '<div class="sb-track"><i class="sb-fill ' + dirCls + '" style="width:' + magPct.toFixed(1) + '%"></i></div>' +
        '<span class="sb-val">' + esc(valTxt) + '</span>' +
      '</div>';
    }).join('');
    const scoreN = firstNum(score, row.score);
    const totalTxt = isFinite(scoreN) ? Math.round(scoreN) : Math.round(sum);
    const total = '<div class="sb-total">加起来 ≈ 股价位置分 <b>' + esc(totalTxt) + '</b></div>';
    return '<details class="sb">' +
      '<summary class="sb-summary">' +
        '<span class="sb-summary-main"><span class="sb-summary-label">股价位置分</span>' +
          '<strong>' + esc(totalTxt) + '</strong><small>/100</small></span>' +
        '<span class="sb-summary-action">看这 ' + present.length + ' 项分别加了多少<span class="sb-chevron" aria-hidden="true">›</span></span>' +
      '</summary>' +
      '<div class="sb-content"><div class="sb-title">这个分是这几项加出来的</div>' +
        '<div class="sb-list">' + barRows + '</div>' +
        total +
        scoreMethodNoteHTML(weights) +
      '</div>' +
    '</details>';
  }

  // 价值陷阱风险:窄 chip(色点 +「价值陷阱:低/中/高」,从首字解析)+ 解释次文(chip 外,可换行)。
  // 首字非 低/中/高 → 不出 chip,只渲染整段文字。
  function vtRiskHTML(vt) {
    const s = String(vt == null ? '' : vt).trim();
    if (!s) return '';
    const sev = s.charAt(0);
    if (sev !== '低' && sev !== '中' && sev !== '高') {
      return '<div class="vt"><p class="vt-note">' + esc(s) + '</p></div>';
    }
    const rest = s.slice(1).replace(/^[\s:：+＋,，、.\-—]+/, '').trim();
    const chip = '<span class="chip vt-chip" title="便宜得有原因、买了以后可能一直不涨的风险">' +
      '<span class="dot ' + vtDotClass(sev) + '"></span>「便宜有陷阱」的风险:' + esc(sev) + '</span>';
    const note = rest ? '<p class="vt-note">' + esc(rest) + '</p>' : '';
    return '<div class="vt">' + chip + note + '</div>';
  }

  /* ---------- 今日分析榜(stats + roster,纯字符串) ---------- */

  // 统计条:扫描候选 / 深度分析 / 推荐 / 观察(仅渲染为有限数的项)
  function buildStatsBarHTML(stats) {
    if (!stats || typeof stats !== 'object') return '';
    const defs = [
      ['电脑算过', stats.scanned],
      ['AI 深入研究', stats.deepDived],
      ['值得关注', stats.published],
      ['先观察', stats.watchlisted]
    ];
    const tiles = defs.filter(function (d) { return isFinite(Number(d[1])); })
      .map(function (d) {
        return '<div class="analysis-stat">' +
          '<div class="analysis-stat-value">' + esc(Number(d[1])) + '</div>' +
          '<div class="analysis-stat-label">' + esc(d[0]) + '</div>' +
        '</div>';
      }).join('');
    if (!tiles) return '';
    return '<div class="analysis-stats">' + tiles + '</div>';
  }

  // 状态 chip:三色结论 + 色点(双通道)。pick=建议买(绿)/ watch=观察(黄)/ rejected=不建议(红)/ skipped=未深析(弱文)
  function statusChipHTML(status) {
    const map = {
      pick: { c: 'roster-chip--pick', d: 'dot-good', t: '值得关注' },
      watch: { c: 'roster-chip--watch', d: 'dot-warn', t: '继续等待' },
      rejected: { c: 'roster-chip--rejected', d: 'dot-crit', t: '不建议买' },
      skipped: { c: 'roster-chip--skipped', d: 'dot-none', t: '还没深入研究' }
    };
    const m = map[status];
    if (!m) return status
      ? '<span class="chip roster-chip"><span class="dot dot-none"></span>' + esc(status) + '</span>' : '';
    return '<span class="chip roster-chip ' + m.c + '"><span class="dot ' + m.d + '"></span>' + esc(m.t) + '</span>';
  }

  // 三色结论图例 + 计数(从 roster 的 status 统计):建议买 / 观察 / 不建议 (/ 未深析)
  function rosterLegendHTML(roster) {
    const arr = Array.isArray(roster) ? roster : [];
    let pick = 0, watch = 0, rej = 0, skip = 0;
    arr.forEach(function (r) {
      if (!r) return;
      if (r.status === 'pick') pick++;
      else if (r.status === 'watch') watch++;
      else if (r.status === 'rejected') rej++;
      else if (r.status === 'skipped') skip++;
    });
    const items = [
      '<span class="roster-legend-item"><span class="dot dot-good"></span>值得关注 ' + pick + '</span>',
      '<span class="roster-legend-item"><span class="dot dot-warn"></span>继续等待 ' + watch + '</span>',
      '<span class="roster-legend-item"><span class="dot dot-crit"></span>不建议买 ' + rej + '</span>'
    ];
    if (skip > 0) items.push('<span class="roster-legend-item"><span class="dot dot-none"></span>还没深入研究 ' + skip + '</span>');
    return '<div class="roster-legend">' + items.join('') + '</div>';
  }

  // scan-only 项展开体:看点(why)+ 角度(angle)+ 来源
  function scanOnlyHTML(item) {
    return '<div class="sections">' +
      secHTML('看点', item.why) +
      secHTML('角度', item.angle) +
    '</div>' + sourcesHTML(item.sources);
  }

  // 数据/可视化区(pick 卡默认可见):retro facts + 窄版价值陷阱 + 统计行 + 评分分解 + 量化评分条 + 走势图 + 短期时点。
  // row = 对应 leaderboard 行(供量化评分条);缺失则量化条优雅跳过。
  // scoreBreakdownHtml = 已生成的「评分分解」面板 HTML(置于量化条上方);缺省则不渲染该面板(向后兼容)。
  function pickDataHTML(p, uid, row, scoreBreakdownHtml, opts) {
    opts = opts || {};
    const md = p.market_data;
    const entry = (p && p.entry) || {};
    return buildRetroFactsHTML(p.retro) +
      (opts.skipValueTrap ? '' : vtRiskHTML(p.value_trap_risk)) +
      buildStatRowHTML(md) +
      (scoreBreakdownHtml || '') +
      quantBarsHTML(row) +
      buildChartBlockHTML(md, uid) +
      buildTimingHTML(entry.timing);
  }

  function researchPanelHTML(title, body, cls) {
    if (!body) return '';
    return '<section class="research-panel' + (cls ? ' ' + cls : '') + '">' +
      '<div class="research-panel-title">' + esc(title) + '</div>' +
      '<p class="research-panel-body">' + esc(body) + '</p>' +
    '</section>';
  }

  // 排行榜展开后先给完整结论，避免缓存的一句话摘要重复出现、并明确这不是概率预测。
  function investmentMemoHTML(p) {
    if (!p || typeof p !== 'object') return '';
    let action = '先等等', actionCls = 'wait';
    if (p.status === 'pick' || p.call === 'buy' || p.action === 'buy') {
      action = '值得关注';
      actionCls = 'buy';
    } else if (p.killed === true || p.call === 'avoid' || p.action === 'sell') {
      action = '建议回避';
      actionCls = 'sell';
    }
    const entry = (p.entry && typeof p.entry === 'object') ? p.entry : {};
    const risk = String(p.value_trap_risk || '').trim();
    const riskLevel = /^[低中高]/.test(risk) ? risk.charAt(0) : '';
    const flags = [
      '<span class="memo-flag memo-flag--' + actionCls + '"><span class="dot"></span>' + esc(action) + '</span>',
    ];
    if (entry.is_low === true) flags.push('<span class="memo-flag">现在的股价确实在低处</span>');
    else if (entry.is_low === false) flags.push('<span class="memo-flag">现在算不算低,证据不够</span>');
    if (riskLevel) flags.push('<span class="memo-flag" title="便宜得有原因、买了以后可能一直不涨的风险">' +
      '「便宜有陷阱」的风险 ' + esc(riskLevel) + '</span>');
    const thesis = p.thesis
      ? '<p class="memo-thesis">' + esc(p.thesis) + '</p>'
      : '<p class="memo-thesis memo-thesis--missing">完整结论暂时没有。</p>';
    return '<section class="investment-memo investment-memo--' + actionCls + '">' +
      '<div class="memo-topline"><span class="memo-eyebrow">AI 的长期结论(看 3 年以上)</span>' +
        '<span class="memo-horizon">' + esc(p.horizon || '3年以上') + '</span></div>' +
      thesis +
      '<div class="memo-flags">' + flags.join('') + '</div>' +
    '</section>';
  }

  // 文字区按「入场依据 → 长期逻辑 → 反方风险 → 推理链」组织；所有原始长文均完整展示。
  function pickTextHTML(p, opts) {
    opts = opts || {};
    const entry = (p && p.entry) || {};
    const isLow = entry.is_low;
    const risks = Array.isArray(p.risks) ? p.risks : [];
    const risksHTML = risks.length
      ? '<section class="research-panel research-panel--risks"><div class="research-panel-title">可能出什么问题</div><ul class="risk-list">' +
        risks.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></section>'
      : '';
    const entryFlag = isLow
      ? '<div class="entry-flag"><span class="dot dot-good"></span><span class="entry-flag-text">现在的股价确实在低处</span></div>'
      : '<div class="entry-flag"><span class="dot dot-warn"></span><span class="entry-flag-text">现在算不算低,证据不够</span></div>';
    const entryEvidence = entry.evidence ? '<p class="entry-evidence">' + esc(entry.evidence) + '</p>' : '';
    const entryHTML = (entryFlag || entryEvidence)
      ? '<section class="research-panel research-panel--entry">' + entryFlag + entryEvidence + '</section>' : '';
    const thesisHTML = opts.includeThesis === false ? ''
      : researchPanelHTML('为什么值得买(AI 的完整理由)', p.thesis, 'research-panel--thesis');
    const longTerm = researchPanelHTML('别人抢不走的优势', p.moat)
      + researchPanelHTML('现在这个价格贵不贵', p.valuation);
    const skeptic = researchPanelHTML('挑毛病的 AI 说了什么', p.skeptic_notes, 'research-panel--skeptic');
    return '<div class="sections research-sections">' +
        entryHTML +
        thesisHTML +
        (longTerm ? '<div class="research-grid">' + longTerm + '</div>' : '') +
        researchPanelHTML('接下来可能发生什么', p.catalysts) +
        risksHTML +
        skeptic +
        researchPanelHTML('AI 一步步是怎么想的', p.evidence_log, 'research-panel--evidence') +
      '</div>' +
      sourcesHTML(p.sources);
  }

  // deep 项 / pick 卡共用的完整详情(不含 pick-head 与 meter)。
  // opts.flat === false → 文字区收进 <details class="full-analysis">(pick 卡:数据优先、文字默认折叠);
  // 否则文字区平铺(roster/watchlist/排行榜展开体本就在 <details> 内,避免二次点击)。
  // opts.row = 对应 leaderboard 行(供量化评分条)。
  function pickDetailHTML(p, uid, opts) {
    opts = opts || {};
    const memo = opts.memo === true;
    const dataViz = pickDataHTML(p, uid, opts.row, opts.scoreBreakdown, { skipValueTrap: memo });
    const text = pickTextHTML(p, { includeThesis: !memo });
    if (memo) {
      const riskNote = vtRiskHTML(p.value_trap_risk);
      return investmentMemoHTML(p) +
        text +
        (riskNote ? '<div class="memo-risk-note">' + riskNote + '</div>' : '') +
        (dataViz ? '<section class="research-data"><div class="research-data-head">' +
          '<div><span class="research-data-eyebrow">用数据核对一下</span><h3>股价现在在什么位置</h3></div>' +
          '<span>只是核对「现在的价格算不算低」，代替不了对公司本身的判断</span></div>' + dataViz + '</section>' : '');
    }
    if (opts.flat === false) {
      return dataViz +
        '<details class="full-analysis"><summary class="full-analysis-sum">查看完整分析</summary>' +
        text + '</details>';
    }
    return dataViz + text;
  }

  // 观察清单单行:<details> summary(ticker + 决策价 + note 一句)+ 展开体。
  // rosterItem = brief.roster 里同 ticker 的深挖项(复用详情渲染);缺失 → 只显示 note。
  // uid 供展开体走势图渐变去重;row = 对应 leaderboard 行(量化评分条)。
  function watchlistRowHTML(w, rosterItem, uid, row) {
    if (!w || typeof w !== 'object') return '';
    const px = firstNum(w.price);
    const priceHTML = isFinite(px) ? '<span class="wl-price">' + esc(money(px, 2)) + '</span>' : '';
    const note = w.note ? String(w.note) : '';
    const noteHTML = note ? '<span class="wl-note">' + esc(note) + '</span>' : '';
    const summary = '<summary class="wl-sum">' +
      '<span class="wl-ticker">' + esc(w.ticker) + '</span>' +
      priceHTML + noteHTML +
      '<span class="wl-caret" aria-hidden="true">›</span>' +
    '</summary>';
    let body;
    if (rosterItem && typeof rosterItem === 'object') {
      body = pickDetailHTML(rosterItem, uid, { flat: true, row: row });
    } else {
      body = note
        ? '<p class="wl-body-note">' + esc(note) + '</p>'
        : '<p class="wl-body-note">这只还没做过深入研究。</p>';
    }
    return '<details class="wl-item">' + summary + '<div class="wl-body">' + body + '</div></details>';
  }

  // 单个 roster 行:<details> summary(名次/代码/名称/状态/1–100 买入把握/结论)+ 展开体
  // uid 仅 deep 项走势图需要;row = 对应 leaderboard 行(供量化评分条),缺失则量化条优雅跳过
  function rosterItemHTML(item, rank, uid, row) {
    if (!item || typeof item !== 'object') return '';
    const isDeep = item.analyzed === 'deep';
    const confidence = rowBuyConfidence(item);
    const confidenceMeta = confidencePresentation(item);
    const convHTML = (isDeep && confidence != null)
      ? '<span class="roster-conv" title="' + esc(CONFIDENCE_CAVEAT) + '">' +
        esc(confidenceMeta.label) + ' ' + esc(confidenceMeta.text)
        + (confidenceMeta.legacy ? ' · 待重算' : '') + '</span>' : '';
    // 历史简报里残留的旧文案「怀疑者否决」展示时换成人话(数据不动,只换显示;
    // 现后端模板已改称「反方复核否决」,见 rosterRejectReason,此处与之对齐)。
    const decisionText = String(item.decision == null ? '' : item.decision)
      .replace(/^怀疑者否决/, '反方复核否决');
    const decision = decisionText
      ? '<div class="roster-decision">' + esc(decisionText) + '</div>' : '';
    const summary =
      '<summary class="roster-sum">' +
        '<div class="roster-sum-top">' +
          '<span class="roster-rank">#' + esc(rank) + '</span>' +
          '<span class="roster-ticker">' + esc(item.ticker) + '</span>' +
          (item.name ? '<span class="roster-name">' + esc(item.name) + '</span>' : '') +
          statusChipHTML(item.status) +
          convHTML +
          '<span class="roster-caret" aria-hidden="true">›</span>' +
        '</div>' +
        decision +
      '</summary>';
    const body = isDeep ? pickDetailHTML(item, uid, { flat: true, row: row }) : scanOnlyHTML(item);
    return '<details class="roster-item roster-item--' + (isDeep ? 'deep' : 'scan') + '">' +
      summary + '<div class="roster-body">' + body + '</div></details>';
  }

  // 今日分析榜整卡(纯字符串)。返回 {html, charts:[{uid,md}]} 供上层挂载走势图;
  // rowLookup(可选):ticker → 对应 leaderboard 行(供 deep 项量化评分条);无 stats 且无 roster → null
  function renderAnalysisSectionHTML(brief, rowLookup) {
    if (!brief || typeof brief !== 'object') return null;
    const roster = Array.isArray(brief.roster) ? brief.roster : null;
    const stats = (brief.stats && typeof brief.stats === 'object') ? brief.stats : null;
    if (!stats && !(roster && roster.length)) return null;
    const charts = [];
    let html = '<section class="card analysis"><div class="block-title">今天研究得最细的 20 只</div>';
    if (roster && roster.length) html += rosterLegendHTML(roster);
    if (stats) html += buildStatsBarHTML(stats);
    if (roster && roster.length) {
      html += '<div class="roster">';
      let seq = 0;
      roster.forEach(function (item, i) {
        if (!item || typeof item !== 'object') return;
        const rank = (item.rank != null) ? item.rank : (i + 1);
        let uid = '';
        if (item.analyzed === 'deep' && item.market_data) {
          uid = 'r' + (++seq);
          charts.push({ uid: uid, md: item.market_data });
        }
        const row = (typeof rowLookup === 'function') ? rowLookup(item.ticker) : null;
        html += rosterItemHTML(item, rank, uid, row);
      });
      html += '</div>';
    }
    html += '</section>';
    return { html: html, charts: charts };
  }

  /* ---------- 历史成绩单(performance,纯字符串) ---------- */

  // 攒够多少笔才值得谈成绩:目标 100 笔「当天实时发出、彼此独立」的记录。
  // 这是给用户看进度用的目标值,不参与任何评分计算。
  const PERF_SAMPLE_TARGET = 100;

  // 中位数(排序后正中间的数;偶数个取中间两个的平均)。空数组 → null。
  function medianOf(nums) {
    const arr = (Array.isArray(nums) ? nums : []).filter(function (n) { return isFinite(Number(n)); })
      .map(Number).sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    const mid = arr.length >> 1;
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  // 纯函数:成绩单样本统计。逐条数 perf.picks,不采信 summary 里的汇总数——
  // 曾出现 summary.tracked=34 而 picks 实际 155 条(漏记了早盘/收盘场次的推荐)。
  //   bought  = 系统当时说「可以买入」的记录(kind ≠ 'watch')
  //   blocked = 系统当时说「先别买」的记录(kind === 'watch'),即被门槛拦下的那批
  //   backfilled = 逐条标了「事后补记」的条数;数据里没有这个标记时为 null(如实标缺失)
  function perfSampleStats(perf) {
    const picks = (perf && Array.isArray(perf.picks)) ? perf.picks.filter(function (p) {
      return p && typeof p === 'object';
    }) : [];
    const bought = picks.filter(function (p) { return p.kind !== 'watch'; });
    const blocked = picks.filter(function (p) { return p.kind === 'watch'; });
    const uniq = function (list) {
      const seen = Object.create(null);
      let n = 0;
      list.forEach(function (p) {
        const t = String(p.ticker == null ? '' : p.ticker).toUpperCase();
        if (!t || seen[t]) return;
        seen[t] = 1; n += 1;
      });
      return n;
    };
    // 「事后补记」标记:track.js 若逐条落了 backfill/backfilled 才能统计,否则如实报缺失
    let backfilled = null;
    picks.forEach(function (p) {
      if (typeof p.backfill === 'boolean' || typeof p.backfilled === 'boolean') {
        backfilled = (backfilled || 0) + ((p.backfill === true || p.backfilled === true) ? 1 : 0);
      }
    });
    const alphaOf = function (p) { return firstNum(p.alphaPct, p.alpha); };
    const blockedWithAlpha = blocked.filter(function (p) { return isFinite(alphaOf(p)); });
    // 明细整个缺失(旧文件/接口降级)时,退回 summary 里的笔数,至少别把有记录说成 0
    const sum = (perf && perf.summary && typeof perf.summary === 'object') ? perf.summary : {};
    const fallbackTracked = firstNum(sum.tracked, sum.totalPicks);
    return {
      tracked: (!picks.length && isFinite(fallbackTracked)) ? fallbackTracked : bought.length,
      unique: uniq(bought),
      medianDays: medianOf(bought.map(function (p) { return p.daysHeld; })),
      target: PERF_SAMPLE_TARGET,
      backfilled: backfilled,
      blocked: blocked.length,
      blockedUnique: uniq(blocked),
      // judgment 由 track.js 按「股价绝对涨跌」判定:跌了=回避正确,涨了=踏空
      blockedFell: blocked.filter(function (p) { return p.judgment === '回避正确'; }).length,
      blockedRose: blocked.filter(function (p) { return p.judgment === '踏空'; }).length,
      // 同一批记录按「比大盘」重算,才是判断门槛松紧的口径
      blockedRated: blockedWithAlpha.length,
      blockedLostToMarket: blockedWithAlpha.filter(function (p) { return alphaOf(p) < 0; }).length,
      blockedBeatMarket: blockedWithAlpha.filter(function (p) { return alphaOf(p) > 0; }).length
    };
  }

  // 成绩单入口卡:只报样本量,不报任何胜率
  function perfEntryHTML(perf) {
    const st = perfSampleStats(perf);
    const countLine = st.tracked
      ? '<span class="perf-entry-count">已追踪 ' + esc(st.tracked) + ' 笔</span>'
      : '';
    const summaryLine = st.tracked
      ? '<p class="perf-entry-summary">' + esc(st.unique) + ' 家不重复公司 · 样本还不够，暂不给胜率</p>'
      : '<p class="perf-entry-summary">还没有可核对的记录</p>';
    return '<section class="card perf-entry" id="perfEntry" role="button" tabindex="0" aria-label="查看历史成绩单">' +
      '<div class="perf-entry-head">' +
        '<span class="perf-entry-title">📊 历史成绩单</span>' +
        countLine +
      '</div>' +
      summaryLine +
    '</section>';
  }

  // 样本进度条:已攒记录 / 目标 100 笔。这是「攒够没有」的进度,不是成绩。
  function perfSampleBarHTML(tracked, target) {
    const t = isFinite(Number(target)) && Number(target) > 0 ? Number(target) : PERF_SAMPLE_TARGET;
    const n = Math.max(0, isFinite(Number(tracked)) ? Number(tracked) : 0);
    const w = Math.max(0, Math.min(100, (n / t) * 100));
    return '<div class="perf-progress">' +
      '<div class="perf-progress-head"><span>样本进度</span>' +
        '<span class="perf-progress-num"><b>' + esc(n) + '</b> / ' + esc(t) + ' 笔</span></div>' +
      '<div class="perf-bar" role="img" aria-label="样本进度 ' + esc(n) + ' 笔，目标 ' + esc(t) + ' 笔">' +
        '<i class="perf-bar-fill" style="width:' + w.toFixed(1) + '%"></i></div>' +
      '<p class="perf-progress-foot">目标：攒够 ' + esc(t) +
        ' 笔「当天实时发出、不同公司」的记录，再来算跑赢大盘的比例。</p>' +
    '</div>';
  }

  // 成绩单顶部摘要:样本量 + 进度条 + 「为什么还不给胜率」+ 被拦下那批的真实去向。
  // 硬规则(2026-07-28):本页不得出现任何胜率百分比。
  function perfSummaryHTML(perf) {
    const s = (perf && perf.summary && typeof perf.summary === 'object') ? perf.summary : (perf || {});
    const st = perfSampleStats(perf);
    const tiles = [
      statTile('已追踪', esc(st.tracked) + ' 笔', false),
      statTile('不重复公司', esc(st.unique) + ' 家', false),
      statTile('中位持有', st.medianDays == null ? '—' : esc(Math.round(st.medianDays)) + ' 天', false)
    ];
    const backfillLine = st.backfilled == null
      ? '<li>这些记录里可能混有「先有行情、后补记录」的历史日期，当前数据没有逐条标记，<b>无法分开统计</b>——所以更不能当成预测能力的证据。</li>'
      : '<li>其中 <b>' + esc(st.backfilled) + ' 笔</b>是事后补记的历史日期（不是当天实时发出的判断），本身就不能算预测。</li>';
    const why = '<details class="perf-why"><summary>为什么不显示「胜率」？</summary><ul class="perf-why-list">' +
      '<li>记录太少，而且同一家公司被重复记了多次：' + esc(st.tracked) + ' 笔只来自 ' +
        esc(st.unique) + ' 家公司，实际独立样本远少于笔数。</li>' +
      backfillLine +
      '<li>过去那个「胜率」把「股价涨了」就算赢。行情整体上涨时，随便买什么都会「赢」，这个数说明不了本事。' +
        '真正该看的是<b>比标普 500（美股大盘指数）多赚还是少赚</b>。</li>' +
      '<li>攒够样本前，这里只显示进度，不显示任何胜率百分比。</li>' +
      // RUBRIC v2.4 §0.6:不能让进度条暗示「攒满 100 笔就能证明有能力」。
      '<li><b>就算攒满了，也证明不了「能跑赢大盘」。</b>按这套数据实测的统计功效算，' +
        '要可靠地分辨出「每年比大盘多赚 3 个百分点」这种量级的差别，需要约 <b>114 年</b>的记录。' +
        '所以这一页永远只是<b>事实记录</b>，不是能力证明——详见底部「算法」页开头。</li>' +
    '</ul></details>';
    const ar = firstNum(s.avgReturnPct, perf.avgReturn, perf.avgReturnPct);
    const al = firstNum(s.avgAlphaPct, perf.avgAlpha, perf.avgAlphaPct);
    const rawTiles = [];
    if (isFinite(ar)) rawTiles.push(statTile('平均涨跌', deltaHTML(ar, 'stat-delta'), false));
    if (isFinite(al)) rawTiles.push(statTile('平均比大盘', deltaHTML(al, 'stat-delta'), false));
    const raw = rawTiles.length
      ? '<div class="perf-raw"><div class="perf-sub-title">这批记录目前的原始数字</div>' +
        '<div class="stat-row">' + rawTiles.join('') + '</div>' +
        '<p class="perf-raw-note">「比大盘」＝同一段时间里比买标普 500 多赚(+)或少赚(−)的百分点。' +
        '样本同上，尚不足以下结论，只作事实记录。</p></div>'
      : '';
    return '<section class="card perf-sample">' +
      '<div class="block-title">样本进度</div>' +
      '<div class="stat-row perf-summary">' + tiles.join('') + '</div>' +
      perfSampleBarHTML(st.tracked, st.target) +
      '<p class="perf-nowinrate">样本不足以谈胜率，这里先如实报进度。</p>' +
      why + raw +
      perfBlockedHTML(st) +
    '</section>';
  }

  // 被门槛拦下的那批(系统当时说「先别买」)后来怎么样了——判断门槛松紧的真信号。
  // 数据里没有这批记录时返回 ''(不编)。
  function perfBlockedHTML(st) {
    if (!st || !st.blocked) {
      return '<p class="perf-blocked-missing">被拦下的股票后来涨没涨，当前数据里没有记录，暂时无法显示。</p>';
    }
    const recount = st.blockedRated
      ? '<p class="perf-blocked-recount">按「比大盘」重算同一批：' +
        '<b>' + esc(st.blockedLostToMarket) + ' 笔</b>跑输大盘（不买是对的）、' +
        '<b>' + esc(st.blockedBeatMarket) + ' 笔</b>跑赢大盘（确实错过了）；' +
        '另有 ' + esc(st.blockedRated - st.blockedLostToMarket - st.blockedBeatMarket) + ' 笔与大盘持平。</p>'
      : '<p class="perf-blocked-recount">这批记录暂缺同期大盘数据，无法按「比大盘」重算。</p>';
    return '<div class="perf-blocked">' +
      '<div class="perf-sub-title">被拦下的股票后来怎么样了</div>' +
      '<p class="perf-blocked-lead">系统当时判断「先别买」的共 <b>' + esc(st.blocked) + ' 笔</b>（' +
        esc(st.blockedUnique) + ' 家公司）。</p>' +
      '<div class="perf-blocked-row">' +
        '<span class="perf-blocked-item perf-blocked-item--good"><b>' + esc(st.blockedFell) +
          '</b> 笔后来跌了<small>没买对了</small></span>' +
        '<span class="perf-blocked-item perf-blocked-item--bad"><b>' + esc(st.blockedRose) +
          '</b> 笔后来涨了<small>没买错过了</small></span>' +
      '</div>' +
      recount +
      '<p class="perf-blocked-note">上面两个数按股价自己的涨跌算，没扣掉大盘涨幅；大盘上涨期间「后来涨了」偏多是正常的，' +
        '所以要看下面那行「比大盘」的重算结果。</p>' +
    '</div>';
  }

  /* ---------- 成绩趋势(每日快照 → 两块独立小折线,绝不双轴) ---------- */

  // 单指标 sparkline 面板(纯字符串 SVG):2px 线 + 数据点(native <title> 悬浮值)+ 末点直标 + 首末日期。
  // <2 个有效点返回 ''。zeroLine=true 画 0 基准虚线(超额这类正负指标)。
  function perfSparkHTML(title, dates, vals, unit, zeroLine) {
    const pts = [];
    for (let i = 0; i < vals.length; i++) {
      const v = Number(vals[i]);
      if (isFinite(v)) pts.push({ d: dates[i], v: v, i: i });
    }
    if (pts.length < 2) return '';
    const W = 300, H = 72, PAD = 8;
    let lo = Math.min.apply(null, pts.map(function (p) { return p.v; }));
    let hi = Math.max.apply(null, pts.map(function (p) { return p.v; }));
    if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const n = vals.length;
    const x = function (i) { return PAD + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD)); };
    const y = function (v) { return PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD); };
    const path = pts.map(function (p, k) { return (k ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
    const zero = zeroLine
      ? '<line class="pspark-zero" x1="' + PAD + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - PAD) + '" y2="' + y(0).toFixed(1) + '"/>'
      : '';
    const dots = pts.map(function (p) {
      return '<circle class="pspark-dot" cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="3.5">' +
        '<title>' + esc(p.d + ':' + p.v + unit) + '</title></circle>';
    }).join('');
    const last = pts[pts.length - 1];
    return '<div class="pspark">' +
      '<div class="pspark-head"><span class="pspark-title">' + esc(title) + '</span>' +
        '<span class="pspark-last">' + esc(last.v + unit) + '</span></div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(title + '趋势') + '">' +
        zero + '<path class="pspark-line" d="' + path + '"/>' + dots +
      '</svg>' +
      '<div class="pspark-x"><span>' + esc(pts[0].d.slice(5)) + '</span><span>' + esc(last.d.slice(5)) + '</span></div>' +
    '</div>';
  }

  // 趋势卡:累计追踪笔数 与 平均比大盘% 两块独立面板(量纲不同绝不同轴)+ 逐日数据表。历史<2天 → 冷启动占位。
  function perfTrendHTML(history) {
    const rows = Array.isArray(history) ? history.filter(function (r) { return r && r.date; }) : [];
    let body;
    if (rows.length < 2) {
      body = '<p class="perf-trend-empty">每日快照已开始记录(现有 ' + rows.length +
        ' 天);积累满 2 天后这里显示「累计追踪笔数」与「平均比大盘」的逐日曲线。</p>';
    } else {
      const dates = rows.map(function (r) { return r.date; });
      // 胜率曲线已撤(定义是「涨了就算赢」,涨市里必然趋近 100%,是误导)。
      // 换成「累计追踪笔数」——看的是样本攒得快不快,这个数不会骗人。
      body =
        perfSparkHTML('累计追踪笔数', dates, rows.map(function (r) { return r.tracked; }), ' 笔', false) +
        perfSparkHTML('平均比大盘 %', dates, rows.map(function (r) { return r.avgAlphaPct; }), '%', true);
    }
    const table = rows.length
      ? '<details class="perf-trend-table"><summary>逐日数据 ' + rows.length + ' 天</summary><table>' +
        '<tr><th>日期</th><th>追踪笔数</th><th>平均涨跌</th><th>平均比大盘</th></tr>' +
        rows.map(function (r) {
          const f = function (v, u) { return (v == null || !isFinite(Number(v))) ? '—' : Number(v) + (u || ''); };
          return '<tr><td>' + esc(r.date) + '</td><td>' + esc(f(r.tracked)) +
            '</td><td>' + esc(f(r.avgReturnPct, '%')) + '</td><td>' + esc(f(r.avgAlphaPct, '%')) + '</td></tr>';
        }).join('') + '</table></details>'
      : '';
    return '<section class="card perf-trend"><div class="block-title">📈 每日趋势</div>' + body + table + '</section>';
  }

  // 复盘单条 call —— 一行可扫读:代码 + ✓/✗ chip + 大白话数字(持有N天涨X% · 比大盘±Y%);
  // 文字(当初依据/改进)折进展开体。rec = 同 ticker+推荐日 的追踪记录;缺失则行上不出数字。
  function perfCallHTML(c, rec) {
    if (!c || typeof c !== 'object') return '';
    const label = String(c.assessment || '').replace(/^判断/, '') || '—';
    const chip = '<span class="chip review-assess"><span class="dot ' + assessDot(c.assessment) + '"></span>' + esc(label) + '</span>';
    const ret = rec ? firstNum(rec.returnPct) : NaN;
    const al = rec ? firstNum(rec.alphaPct) : NaN;
    const days = rec ? firstNum(rec.daysHeld) : NaN;
    const nums =
      (isFinite(ret) ? '<span class="rc-num"><span class="rc-lbl">' +
        (isFinite(days) ? '持有' + esc(days) + '天' : '至今') + '</span>' + deltaHTML(ret, 'stat-delta') + '</span>' : '') +
      (isFinite(al) ? '<span class="rc-num rc-alpha"><span class="rc-lbl">比大盘</span>' + deltaHTML(al, 'stat-delta') + '</span>' : '');
    // 硬事实行:推荐价 → 现价(代码追踪的真实数据);预期口径如实说明(系统不设目标价)
    const px0 = rec ? firstNum(rec.entryPrice) : NaN;
    const px1 = rec ? firstNum(rec.currentPrice) : NaN;
    const facts = (isFinite(px0) && isFinite(px1))
      ? '<p class="rc-facts">推荐价 $' + esc(px0) + ' → 现价 $' + esc(px1) +
        (isFinite(days) ? '(' + esc(days) + ' 天)' : '') +
        ' · 我们看的是「3 年以上能不能比大盘多赚」,不设目标价,也不看短期涨跌</p>'
      : '';
    const body = facts +
      '<p class="rc-explain">「' + esc(label) + '」= AI 复盘对照事后真实走势,评定当日这条判断是否成立;下面是当初的判断依据。</p>' +
      (c.why ? '<p class="review-call-why">' + esc(c.why) + '</p>' : '') +
      (c.lesson ? '<p class="review-call-lesson">改进:' + esc(c.lesson) + '</p>' : '');
    return '<details class="review-call">' +
      '<summary class="rc-row">' +
        '<span class="review-call-ticker">' + esc(c.ticker) + '</span>' +
        chip + '<span class="rc-nums">' + nums + '</span><span class="lb-caret" aria-hidden="true">›</span>' +
      '</summary>' +
      '<div class="rc-body">' + body + '</div>' +
    '</details>';
  }

  // 复盘卡:图例计数 + summary 段 + 一行式 calls 列表 + improvements 要点;全空则跳过
  function perfReviewHTML(review, picks, meta) {
    // AI 评语新鲜度:Static 场只刷新数字、沿用旧评语(review.js 负责如实保留 review_as_of);
    // 这里把 meta.review_stale 直接标出来,不让旧评语看起来像今天写的。
    if (!review || typeof review !== 'object') return '';
    const summary = review.summary ? String(review.summary) : '';
    const calls = Array.isArray(review.calls) ? review.calls : [];
    const improvements = Array.isArray(review.improvements) ? review.improvements : [];
    if (!summary && !calls.length && !improvements.length) return '';
    // 追踪记录索引:优先「ticker|推荐日」精确匹配(同一 ticker 可能被多天推荐,只按 ticker 会串数字),
    // 兜底 ticker 唯一时按 ticker。
    const recByKey = {};
    const recByTicker = {};
    (Array.isArray(picks) ? picks : []).forEach(function (p) {
      if (!p || !p.ticker) return;
      const d = p.entryDate || p.date;
      if (d) recByKey[p.ticker + '|' + d] = p;
      recByTicker[p.ticker] = (p.ticker in recByTicker) ? null : p; // 出现多条 → 置 null,禁止模糊匹配
    });
    function recFor(c) {
      if (!c || !c.ticker) return null;
      return recByKey[c.ticker + '|' + c.date] || recByTicker[c.ticker] || null;
    }
    let html = '<section class="card review"><div class="block-title">AI 自我复盘</div>';
    const rmeta = meta && typeof meta === 'object' ? meta : {};
    const staleDay = rmeta.review_stale === true && typeof rmeta.review_as_of === 'string'
      && /^\d{4}-\d{2}-\d{2}/.test(rmeta.review_as_of) ? rmeta.review_as_of.slice(0, 10) : null;
    if (staleDay) {
      html += '<p class="simple-muted">AI 评语截至 ' + esc(staleDay)
        + '（之后 AI 未运行，暂未更新；本页数字每天照常更新）。</p>';
    }
    if (calls.length) {
      let ok = 0, bad = 0, other = 0;
      calls.forEach(function (c) {
        const a = c ? String(c.assessment || '') : '';
        if (a.indexOf('正确') > -1) ok++; else if (a.indexOf('错误') > -1) bad++; else other++;
      });
      html += '<div class="review-legend">' +
        '<span class="roster-legend-item"><span class="dot dot-good"></span>正确 ' + ok + '</span>' +
        '<span class="roster-legend-item"><span class="dot dot-crit"></span>错误 ' + bad + '</span>' +
        (other ? '<span class="roster-legend-item"><span class="dot dot-warn"></span>部分 ' + other + '</span>' : '') +
      '</div>' +
      '<p class="review-howto">按推荐日期分组,最新在前;正确/错误 = AI 复盘对照事后真实走势评定当日判断。' +
        '涨跌 = 从推荐日买入到现在的真实涨跌;比大盘 = 同期比买标普500(SPY)多赚/少赚。' +
        '本系统只判断「长期低位值不值得买」,不预测点位,故无“预期价格”一栏;点行可看当初判断依据。</p>' +
      // 复盘正文是 AI 自己写的原话,原样保留(不删改)。但它可能引用旧口径的「胜率/命中率」,
      // 那个数已被本页撤下,必须就地说明,免得用户当成产品的成绩承诺。
      '<p class="review-howto review-howto--warn">下面是 AI 自己写的原话，未作删改。' +
        '如果文中引用了「胜率」或「命中率」，那是按「股价涨了就算赢」的旧算法得出的，' +
        '本页已不再采用（原因见上方「为什么不显示『胜率』？」）。</p>';
    }
    if (summary) html += '<p class="sec-body review-summary">' + esc(summary) + '</p>';
    if (calls.length) {
      // 按推荐日分组,最新日期在前;最新一组默认展开
      const byDate = {};
      calls.forEach(function (c) {
        const d = (c && c.date) ? String(c.date) : '未知日期';
        (byDate[d] = byDate[d] || []).push(c);
      });
      const dates = Object.keys(byDate).sort().reverse();
      // 默认展开:最新的一个「已有评定结果」的日期组(全是"尚早/待观察"的组不展开;混合的算有结果)
      const counts = {};
      dates.forEach(function (d) {
        let gok = 0, gbad = 0;
        byDate[d].forEach(function (c) {
          const a = String((c && c.assessment) || '');
          if (a.indexOf('正确') > -1) gok++; else if (a.indexOf('错误') > -1) gbad++;
        });
        counts[d] = { gok: gok, gbad: gbad };
      });
      html += '<div class="review-calls">';
      dates.forEach(function (d) {
        const group = byDate[d];
        const gok = counts[d].gok, gbad = counts[d].gbad;
        const pending = group.length - gok - gbad;
        // 全部默认展开;组里全是「尚早」(无任何对错结果)才收起
        const open = gok + gbad > 0;
        html += '<details class="review-group"' + (open ? ' open' : '') + '>' +
          '<summary class="review-group-head">' +
            '<span class="rg-date">' + esc(d) + '</span>' +
            '<span class="rg-n">推荐 ' + group.length + ' 笔</span>' +
            '<span class="rg-counts">' +
              (gok ? '<span class="dot dot-good"></span>对' + gok + ' ' : '') +
              (gbad ? '<span class="dot dot-crit"></span>错' + gbad + ' ' : '') +
              (pending ? '<span class="dot dot-none"></span>尚早' + pending : '') +
            '</span>' +
            '<span class="lb-caret" aria-hidden="true">›</span></summary>';
        group.forEach(function (c) { html += perfCallHTML(c, recFor(c)); });
        html += '</details>';
      });
      html += '</div>';
    }
    if (improvements.length) {
      html += '<div class="sec review-improve"><div class="sec-title">改进方向</div><ul class="risk-list">' +
        improvements.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>';
    }
    html += '</section>';
    return html;
  }

  // 单个已追踪推荐行:代码/名称 + 推荐日 + 入场价→现价 + 收益(delta)+ 超额 + 判断 chip
  function perfPickRowHTML(p) {
    if (!p || typeof p !== 'object') return '';
    const date = firstDefined(p.date, p.pickDate, p.recommendedDate);
    const entryPx = firstNum(p.entryPrice, p.entry_price, p.entryPx);
    const curPx = firstNum(p.currentPrice, p.price, p.current_price);
    const retPct = firstNum(p.returnPct, p.return_pct);
    const alpha = firstNum(p.alpha, p.alphaPct);
    const judgment = p.judgment;
    const idHTML =
      '<div class="perf-row-id">' +
        '<span class="perf-ticker">' + esc(p.ticker) + '</span>' +
        (p.name ? '<span class="perf-name">' + esc(p.name) + '</span>' : '') +
      '</div>';
    const metaParts = [];
    if (date) metaParts.push('<span class="perf-date">推荐日 ' + esc(date) + '</span>');
    if (isFinite(entryPx) || isFinite(curPx)) {
      metaParts.push('<span class="perf-px">' +
        (isFinite(entryPx) ? esc(money(entryPx, 2)) : '—') + ' → ' +
        (isFinite(curPx) ? esc(money(curPx, 2)) : '—') + '</span>');
    }
    const metaHTML = metaParts.length ? '<div class="perf-row-meta">' + metaParts.join('') + '</div>' : '';
    const numParts = [];
    if (isFinite(retPct)) numParts.push(deltaHTML(retPct, 'perf-ret'));
    if (isFinite(alpha)) numParts.push('<span class="perf-alpha">超额 ' + deltaHTML(alpha, 'perf-alpha-d') + '</span>');
    if (judgment) numParts.push('<span class="chip perf-judge"><span class="dot ' + assessDot(judgment) + '"></span>' + esc(judgment) + '</span>');
    const numHTML = numParts.length ? '<div class="perf-row-nums">' + numParts.join('') + '</div>' : '';
    return '<div class="perf-row">' + idHTML + metaHTML + numHTML + '</div>';
  }

  // 已追踪推荐列表卡;空则跳过
  function perfPicksHTML(picks) {
    if (!Array.isArray(picks) || !picks.length) return '';
    const rows = picks.map(perfPickRowHTML).join('');
    return '<section class="card perf-picks"><div class="block-title">已追踪推荐</div>' + rows + '</section>';
  }

  /* ==================== 全市场排行榜(leaderboard,纯函数) ====================
     统一口径(2026-07-16 起):
     - confidence_level = 当前买入研究把握分(1–100,非概率);score = 建议度/候选分。
     - band(color) = 建议度三档:green ≥60 / yellow ≥40 / red <40。
     - call(AI 徽章) = 建议买/建议等/不建议,仅深挖的前 20 只;quant_score 保留原量化低位分供评分分解。
     所有面向数据的字符串一律经 esc;缺字段优雅降级,绝不抛错。 */

  // 归一化小写字符串(搜索用);null/undefined → ''
  function lbNorm(s) { return String(s == null ? '' : s).toLowerCase(); }

  // 前端也 fail closed：只有明确新版来源 + 原生 1–100 + 完整深挖的达标结论
  // 才能显示买入。这样即使读到尚未重算的旧榜单，也不会把旧 call/action=buy
  // 当作当前行动。
  function hasNativeConfidence(r) {
    if (!r || typeof r !== 'object') return false;
    const n = firstNum(r.confidence_level);
    const sourceOk = r.confidence_source === 'native_v2'
      || String(r.confidence_scale || '').indexOf('v2.') === 0;
    return sourceOk && isFinite(n) && Math.round(n) === n && n >= 1 && n <= 100;
  }

  function isActionableBuyRow(r) {
    const n = r && firstNum(r.confidence_level);
    return !!r && r.deep === true && r.call === 'buy' && r.analysis_kind === 'full'
      && hasNativeConfidence(r) && n >= 60;
  }

  function isActionableSellRow(r) {
    const n = r && firstNum(r.confidence_level);
    return !!r && r.deep === true && r.call === 'avoid'
      && (r.analysis_kind === 'full' || r.analysis_kind === 'lite')
      && hasNativeConfidence(r) && n <= 39;
  }

  // 纯函数:行的 v2.1 行动档(buy/sell/wait/candidate)。所有消费方统一走这里，
  // 保证筛选、徽章、首屏与计数口径完全相同。
  function rowAction(r) {
    if (!r || typeof r !== 'object') return 'candidate';
    if (r.action === 'buy') return isActionableBuyRow(r) ? 'buy' : (r.deep ? 'wait' : 'candidate');
    if (r.action === 'sell') return isActionableSellRow(r) ? 'sell' : (r.deep ? 'wait' : 'candidate');
    if (r.action === 'wait' || r.action === 'candidate') return r.action;
    if (!r.deep) return 'candidate';
    if (r.call === 'buy') return isActionableBuyRow(r) ? 'buy' : 'wait';
    if (r.call === 'avoid') return isActionableSellRow(r) ? 'sell' : 'wait';
    return 'wait';
  }

  // v2.0 当前买入研究把握分(1–100)。优先读新字段；旧简报仅兼容
  // conviction×10 并明确标记来源。绝不再从 ±signal 反推，缺分就显示待核实。
  function rowBuyConfidence(r) {
    if (!r || typeof r !== 'object') return null;
    let n = firstNum(r.confidence_level);
    if (isFinite(n) && n >= 1 && n <= 100) return Math.round(n);
    n = firstNum(r.conviction);
    if (isFinite(n) && n >= 1 && n <= 10) return Math.round(n * 10);
    return null;
  }

  function isLegacyConfidence(r) {
    if (!r || typeof r !== 'object') return false;
    return rowBuyConfidence(r) != null && !hasNativeConfidence(r);
  }

  // 这个 1–100 分的用户可见名字。内部字段仍叫 confidence_level（后端契约不动），
  // 但界面上不许再叫「买入把握」——「把握」会被读成「有多大把握会涨」，而 RUBRIC §0 的
  // 实测结论是它对涨跌没有排序能力（rankIC t=0.06）。它衡量的只是「买入这个理由被查证得多完整」。
  const CONFIDENCE_LABEL = '买入理由完整度';
  // 凡是把这个分摆出来的地方，都要跟着这句;删掉它等于默许用户把它当涨跌概率读。
  const CONFIDENCE_CAVEAT = '这个分只表示「买入的理由查得多完整」，不是涨跌概率，也不是跑赢大盘的可能性。';

  // 旧 1–10 只能展示原始档位，不能把 7/10 写成看似更精确的 70/100。
  // 排序内部仍可用等价换算值，原生复核完成后才显示真正的 N/100。
  function confidencePresentation(r) {
    const confidence = rowBuyConfidence(r);
    const legacy = isLegacyConfidence(r);
    if (confidence == null) {
      return {
        legacy: legacy,
        label: legacy ? '旧版评分' : CONFIDENCE_LABEL,
        value: '还没核实',
        denom: '',
        text: '还没核实',
        aria: CONFIDENCE_LABEL + '还没核实'
      };
    }
    if (legacy) {
      const direct = firstNum(r && r.conviction);
      const raw = isFinite(direct) && direct >= 1 && direct <= 10 ? direct : confidence / 10;
      const value = Math.abs(raw - Math.round(raw)) < 0.001 ? String(Math.round(raw)) : raw.toFixed(1);
      return {
        legacy: true,
        label: '旧版评分',
        value: value,
        denom: '/10',
        text: value + '/10',
        aria: '旧版评分 ' + value + ' 分，满分 10 分，还要按现在的标准重新核实'
      };
    }
    return {
      legacy: false,
      label: CONFIDENCE_LABEL,
      value: String(confidence),
      denom: '/100',
      text: confidence + '/100',
      aria: CONFIDENCE_LABEL + ' ' + confidence + ' 分，满分 100 分；这只表示买入理由查得多完整，不是涨跌概率'
    };
  }

  /* ---------- 结论出自哪个 AI(2026-07-28 起必须如实标出,2026-09-25 起 + 免费 AI) ----------
     当前主用免费 AI(OpenCode);历史上也可能是 Codex/GPT、Claude 或 Claude 限额后的 GPT 回退。
     结论都入榜,但来源必须让用户一眼看见,不得混同。
     后端契约:行/条目上带 provider 字段,取值 'claude' | 'gpt' | 'opencode'。 */

  // 纯函数:归一化行上的 AI 来源。字段缺失 → ''(什么都不标,绝不默认当成 claude)。
  function providerOf(r) {
    if (!r || typeof r !== 'object') return '';
    const raw = (r.provider != null) ? r.provider : r.ai_provider;
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    if (s.indexOf('opencode') > -1 || s.indexOf('muse-spark') > -1) return 'opencode';
    if (s.indexOf('gpt') > -1 || s.indexOf('codex') > -1 || s.indexOf('openai') > -1) return 'gpt';
    if (s.indexOf('claude') > -1 || s.indexOf('opus') > -1 || s.indexOf('sonnet') > -1
      || s.indexOf('haiku') > -1) return 'claude';
    return '';
  }

  // 纯函数:GPT 结论徽章。非 GPT(含字段缺失)一律返回 '',不显示任何模型名。
  function providerBadgeHTML(r) {
    if (providerOf(r) === 'opencode') {
      return '<span class="chip prov-tag prov-tag--opencode" title="这条结论由免费 AI（OpenCode 免费模型）产出，零付费。">' +
        '免费 AI 研究</span>';
    }
    if (providerOf(r) !== 'gpt') return '';
    return '<span class="chip prov-tag prov-tag--gpt" title="这条结论由 Codex/GPT 产出。">' +
      'GPT 复核中</span>';
  }

  // 纯函数:这一场到底用了哪个 AI。meta.model 只是「本来打算用的模型」,Claude 额度用尽
  // 改用 GPT 时它仍写着 opus——直接显示就是谎报。这里以实际跑过的 provider 为准:
  //   claude 独跑 → '模型 opus'
  //   GPT 参与    → 明说 GPT(有 Claude 的场次写「+ GPT」)
  //   两者都不知道 → 返回 ''(宁可不写,也不猜)
  function researchModelLabel(meta) {
    const m = (meta && typeof meta === 'object') ? meta : {};
    const list = Array.isArray(m.ai_providers) ? m.ai_providers.slice() : [];
    if (m.ai_provider) list.push(m.ai_provider);
    if (m.gpt_fallback_used === true) list.push('gpt');
    if (m.opencode_used === true) list.push('opencode');
    const kinds = {};
    list.forEach(function (p) {
      const k = providerOf({ provider: p });
      if (k) kinds[k] = true;
    });
    const claudeModel = String(m.ai_model || m.model || '').trim();
    if (kinds.gpt && kinds.opencode) {
      return '模型 免费 AI（OpenCode 免费模型）+ GPT（部分结论由 GPT 产出）';
    }
    if (kinds.opencode && kinds.claude) {
      return '模型 ' + (claudeModel || 'Claude') + ' + 免费 AI（部分结论由免费 AI 产出）';
    }
    if (kinds.opencode) {
      return '模型 免费 AI（OpenCode 免费模型）';
    }
    if (kinds.gpt && kinds.claude) {
      return '模型 ' + (claudeModel || 'Claude') + ' + 备用 GPT(部分结论由 GPT 产出)';
    }
    if (kinds.gpt) {
      return m.configured_provider === 'codex' && m.gpt_fallback_used !== true
        ? '模型 Codex/GPT' : '模型 备用 GPT(Claude 额度用完时改用)';
    }
    if (kinds.claude) return claudeModel ? '模型 ' + claudeModel : '模型 Claude';
    // provider 完全没记录(老简报):只能说不确定,不能拿 meta.model 冒充实际跑过的模型
    return claudeModel ? '计划模型 ' + claudeModel + '(未记录实际使用的模型)' : '';
  }

  // 纯函数:任一行是 GPT 产出 → 返回解释句(挂在卡片底部,手机上没有悬停提示也看得到)。
  function providerNoteHTML(rows) {
    const arr = Array.isArray(rows) ? rows : [];
    const hasGpt = arr.some(function (r) { return providerOf(r) === 'gpt'; });
    const hasOpencode = arr.some(function (r) { return providerOf(r) === 'opencode'; });
    if (!hasGpt && !hasOpencode) return '';
    let html = '';
    if (hasGpt) {
      html += '<p class="act-note act-note--prov">标「GPT 复核中」的结论由 Codex/GPT 产出。' +
        '历史 Claude 结论与 Codex/GPT 结论会分开标记，便于分别复核。</p>';
    }
    if (hasOpencode) {
      html += '<p class="act-note act-note--prov">标「免费 AI 研究」的结论由免费 AI（OpenCode 免费模型）产出，不花一分钱模型费用；结论照常附来源链接，可点开核对。</p>';
    }
    return html;
  }

  // 纯函数:按搜索词 q(命中 ticker 或 name)、行动档 filter、行业 sector 过滤行。
  // filter 主维=行动档(与行上 chip 同口径):'buy' | 'sell' | 'wait' | 'candidate'
  //   旧值向后兼容(旧测试/书签):'avoid'→sell,'watch'→wait,'undeep'→candidate,'deep'=仅深挖,
  //   band 'green'|'yellow'|'red' 仍可用;'all' 或未知值不过滤。
  // sector:精确匹配 row.sector;空/'all' 不过滤。
  function filterRows(rows, q, filter, sector) {
    if (!Array.isArray(rows)) return [];
    const query = lbNorm(q).trim();
    let f = filter || 'all';
    if (f === 'avoid') f = 'sell';
    else if (f === 'watch') f = 'wait';
    else if (f === 'undeep') f = 'candidate';
    const sec = (sector && sector !== 'all') ? String(sector) : '';
    return rows.filter(function (r) {
      if (!r || typeof r !== 'object') return false;
      if (f === 'buy' || f === 'sell' || f === 'wait' || f === 'candidate') { if (rowAction(r) !== f) return false; }
      else if (f === 'green' || f === 'yellow' || f === 'red') { if (r.band !== f) return false; }
      else if (f === 'deep') { if (!r.deep) return false; }
      if (sec) { if (String(r.sector || '') !== sec) return false; }
      if (query) {
        if (lbNorm(r.ticker).indexOf(query) === -1 && lbNorm(r.name).indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  // 纯函数:AI 结论年龄(analyzed_on 相对榜单日 refDate 的天数)→ {days, label, cls}。
  // 时效可见性(用户要求):今天/昨天/N天前直接标在行上;>14 天加 lb-age--old(黄)提醒接近 21 天有效期。
  // 任一日期缺失或不合法 → null(行上不显示,优雅跳过)。
  function ageMeta(analyzedOn, refDate) {
    if (!analyzedOn || !refDate) return null;
    const a = Date.parse(String(analyzedOn));
    const b = Date.parse(String(refDate));
    if (!isFinite(a) || !isFinite(b)) return null;
    const days = Math.max(0, Math.round((b - a) / 86400000));
    const label = days === 0 ? '今天' : days === 1 ? '昨天' : days + '天前';
    return { days: days, label: label, cls: days > 14 ? 'lb-age--old' : '' };
  }

  // 纯函数:榜单新鲜度总览一行——今天更新 N · 一周内 M · 最旧 K 天;无深挖行 → ''。
  // 附一句买入行的保障说明,让「不是每天每只都重挖」的兜底机制可见。
  function lbFreshnessHTML(rows, refDate) {
    const arr = Array.isArray(rows) ? rows : [];
    let deep = 0, today = 0, week = 0, oldest = 0;
    arr.forEach(function (r) {
      if (!r || !r.deep) return;
      const m = ageMeta(r.analyzed_on, refDate);
      if (!m) return;
      deep += 1;
      if (m.days <= 0) today += 1;
      if (m.days <= 7) week += 1;
      if (m.days > oldest) oldest = m.days;
    });
    if (!deep) return '';
    return '<p class="lb-fresh">🕐 AI 结论有多新:今天更新 <b>' + today + '</b> · 一周内 <b>' + week +
      '</b>/' + deep + ' · 最旧 <b>' + oldest + '</b> 天(一条结论最多用 21 天;股价涨跌超过 10% 当天就重新研究;' +
      '标着「↑ 值得关注」的过期后最先重排)</p>';
  }

  // 纯函数:「今日重点」首屏——先回答「哪几只最值得我现在看」。
  // 买入按 1–100 当前买入把握分从高到低；回避只收明确 call=avoid，并按买入把握
  // 从低到高。低分 watch 不再被反推成看跌。
  // opts:{refDate, aiRan, staticOnly(旧名), fallbackReason, loading}。
  // aiRan===false(AI 今天没跑成)时:列表里的结论全是以前分析的旧结论,必须当场说清楚,
  // 空名单也不许写成「今天无需操作」——那是把系统故障说成投资结论(v2.2 A2)。
  function todayActionsHTML(rows, noPickReason, opts) {
    opts = opts || {};
    const aiIdle = opts.aiRan === false || (opts.aiRan == null && opts.staticOnly === true);
    const arr = Array.isArray(rows) ? rows : [];
    const confOf = function (r) { return rowBuyConfidence(r); };
    const buys = arr.filter(function (r) { return rowAction(r) === 'buy'; })
      .sort(function (a, b) {
        return Number(isLegacyConfidence(a)) - Number(isLegacyConfidence(b))
          || (confOf(b) == null ? -1 : confOf(b)) - (confOf(a) == null ? -1 : confOf(a));
      });
    const sells = arr.filter(function (r) { return rowAction(r) === 'sell'; })
      .sort(function (a, b) {
        return Number(isLegacyConfidence(a)) - Number(isLegacyConfidence(b))
          || (confOf(a) == null ? 101 : confOf(a)) - (confOf(b) == null ? 101 : confOf(b));
      });
    const TOP = 3;
    const item = function (r, kind, index) {
      const confidence = confOf(r);
      const confidenceMeta = confidencePresentation(r);
      const confidenceText = confidenceMeta.text;
      const legacyConfidence = confidenceMeta.legacy;
      const priority = index === 0;
      const age = ageMeta(r.analyzed_on, opts.refDate);
      const ageHTML = age
        ? '<span class="act-age' + (age.cls ? ' ' + age.cls : '') + '">' + esc(age.label) + '结论</span>'
        : '';
      const why = r.ai_note ? '<div class="act-why">' + esc(plainifyAiNote(r.ai_note)) + '</div>' : '';
      const actionText = kind === 'buy' ? '买入关注' : '回避复核';
      const provBadge = providerBadgeHTML(r);
      const provKind = providerOf(r);
      const provAria = provKind === 'gpt' ? '，由 Codex/GPT 产出'
        : provKind === 'opencode' ? '，由免费 AI 产出' : '';
      const confidenceAria = confidenceMeta.aria;
      return '<button class="act-item act-item--' + kind + (priority ? ' act-item--priority' : '') +
        '" type="button" data-ticker="' + esc(String(r.ticker == null ? '' : r.ticker).toUpperCase()) +
        '" aria-label="' + esc(r.ticker) + '，' + actionText + '，' + confidenceAria + provAria + '，查看完整依据">' +
        '<span class="act-dir" aria-hidden="true">' + (kind === 'buy' ? '↑' : '↓') + '</span>' +
        '<div class="act-main">' +
          '<div class="act-line1"><b class="act-ticker">' + esc(r.ticker) + '</b>' +
          (priority ? '<span class="act-priority">先看</span>' : '') +
          '<span class="act-confidence">' +
            '<span class="act-confidence-label">' +
              confidenceMeta.label + (legacyConfidence ? ' · 待复核' : '') + '</span>' +
            '<strong class="act-confidence-value">' + esc(confidenceText) + '</strong>' +
          '</span></div>' +
          (r.name ? '<div class="act-name">' + esc(r.name) + '</div>' : '') +
          why +
          '<div class="act-meta">' + ageHTML + provBadge +
            '<span class="act-open">看依据 <span aria-hidden="true">›</span></span></div>' +
        '</div>' +
      '</button>';
    };
    const group = function (list, kind, title, subtitle) {
      if (!list.length) return '';
      const more = list.length > TOP
        ? '<button class="act-more act-more--' + kind + '" type="button" data-action-filter="' + kind + '">' +
          '查看全部 ' + list.length + ' 只' + (kind === 'buy' ? '买入机会' : '明确回避') +
          '<span aria-hidden="true">→</span></button>'
        : '';
      return '<div class="act-group act-group--' + kind + '">' +
        '<div class="act-group-head"><div><div class="act-group-title">' + title + '</div>' +
        '<div class="act-group-sub">' + subtitle + '</div></div>' +
        '<span class="act-group-count">' + list.length + ' 只</span></div>' +
        list.slice(0, TOP).map(function (r, i) { return item(r, kind, i); }).join('') + more + '</div>';
    };
    const shown = Math.min(TOP, buys.length) + Math.min(TOP, sells.length);
    const hasLegacy = buys.concat(sells).some(isLegacyConfidence);
    // 只有真正展示出来的那几只才需要解释 GPT 标记
    const shownRows = buys.slice(0, TOP).concat(sells.slice(0, TOP));
    const dataState = opts.loading
      ? '<div class="act-data-state act-data-state--loading"><span class="dot"></span><span>正在同步全市场结论…</span></div>'
      : aiIdle
      ? '<div class="act-data-state"><span class="dot dot-warn"></span><span><b>今天 AI 未运行,以下不是今天新做的判断</b>' +
        '，每条都是以前 AI 分析的结论，只在有效期内继续显示' +
        (opts.fallbackReason ? ' · ' + esc(aiOutageCause(opts.fallbackReason)) : '') + '</span></div>'
      : '<div class="act-data-state act-data-state--fresh"><span class="dot dot-good"></span><span>已按最新有效结论排序</span></div>';
    let body;
    if (opts.loading) {
      body = '<div class="act-loading" aria-live="polite"><span></span><span></span></div>';
    } else if (!buys.length && !sells.length) {
      body = aiIdle
        // AI 没跑成的日子没有「无需操作」这个结论——系统根本没做判断。
        // 详细说明由页面上方的「今天 AI 未运行」块给出,这里不重复贴后端原文。
        ? '<div class="act-none act-none--idle"><span class="act-none-mark" aria-hidden="true">!</span><div>' +
          '<h3>今天没有新的买入结论</h3>' +
          '<p>今天 AI 未运行，系统没有做新的判断。这不代表今天没有值得买的股票。</p></div></div>'
        : '<div class="act-none"><span class="act-none-mark" aria-hidden="true">✓</span><div>' +
          '<h3>今天无需操作</h3><p>没有明确的买入或回避结论，等待也是策略。</p></div></div>' +
          // no_pick_reason 也是后端代码模板拼的,同样先过名词补丁
          (noPickReason ? '<p class="act-none-why">' + esc(plainifyBackendCopy(noPickReason)) + '</p>' : '');
    } else {
      body = '<div class="act-groups">' +
        // 「最强」会被读成「这几只会涨得最好」——实际只是买入理由查得最完整,RUBRIC v2.4 §0 禁止这种暗示。
        group(buys, 'buy', '值得关注', '买入理由查得最完整的 ' + Math.min(TOP, buys.length) + ' 只') +
        group(sells, 'sell', '风险提醒', 'AI 明确要求回避、建议你重新看一眼的 ' + Math.min(TOP, sells.length) + ' 只') +
      '</div>';
    }
    const title = opts.loading
      ? '正在整理今日重点'
      : shown
      ? '先看这 ' + shown + ' 只股票'
      : aiIdle
      ? '今天没有新的买入结论'
      : '今天没有需要立即处理的股票';
    const intro = opts.loading ? '马上给你最重要的结论。'
      : shown
        // RUBRIC v2.4 §0:首屏这句是曝光最高的一行文案,必须点明「不是跑赢大盘的可能性」。
        ? (aiIdle
          ? '下面这些都是以前 AI 研究出来的结论，今天没有重新核实；' + CONFIDENCE_CAVEAT
          : '箭头是方向：↑ 值得关注、↓ 建议回避。' + CONFIDENCE_CAVEAT)
        : aiIdle ? '今天 AI 未运行，不是市场上没有机会。'
          : '结论很简单：先不动。';
    return '<section class="card act-card" aria-labelledby="todayFocusTitle">' +
      '<div class="act-hero">' +
        '<div><div class="act-eyebrow">今日重点</div><h2 class="act-title" id="todayFocusTitle">' + title + '</h2>' +
        '<p class="act-intro" id="confidenceDefinition">' + intro + '</p></div>' +
        (!opts.loading && (buys.length || sells.length)
          ? '<div class="act-totals"><span class="act-total act-total--buy">↑ ' + buys.length + ' 只值得关注</span>' +
            '<span class="act-total act-total--sell">↓ ' + sells.length + ' 只建议回避</span></div>'
          : '') +
      '</div>' +
      dataState + body +
      (hasLegacy ? '<p class="act-note act-note--legacy">标着「旧版评分」的，直接照原样显示当初的 1–10 分，' +
        '不会换算成看起来更精确的 100 分制；这几只已经排在最前面等着重新研究。</p>' : '') +
      providerNoteHTML(shownRows) +
      // 「怀疑者」是内部说法,对用户写成「专挑毛病的 AI」(文案规范 §1.7)
      '<p class="act-note">分数低不等于它会跌;只有那个专门挑毛病的 AI 找到伤及长期前景的硬伤、并且明确否决，' +
      '才会进「风险提醒」。点开每只股票能看到依据和这条结论是哪天做的。</p>' +
    '</section>';
  }

  /* ---------- 「今天 AI 未运行」告示(v2.2 A2) ----------
     修的是这个 bug:此前只有 meta.static_only 才提示,而且文案是「数据已刷新，AI 结论暂未刷新」,
     既没说 AI 没运行,也没说「不代表没机会」;而后端写好的诚实说明只在「买卖名单都为空」时才渲染。
     买入结论有效期 21 天,AI 没跑的那天榜单上照样摆着旧的买入行(2026-07-24 的磁盘榜单就有 22 行
     标着买入),用户看到的像是一份今天刚做出来的名单。
     纪律:判不准一律按「没跑成」处理(fail-closed),有买入行时照样显示。 */

  // 本场是否真的跑成了 AI(与 tools/research.js aiRanInSession 同口径,包括老简报的推断顺序)
  function aiRanInBrief(brief) {
    if (!brief || typeof brief !== 'object') return false;
    const meta = brief.meta || {};
    if (typeof meta.ai_ran === 'boolean') return meta.ai_ran;
    if (meta.static_only) return false;                       // 老简报回退:只有这个字段可信
    const deep = brief.stats ? Number(brief.stats.deepDived) : NaN;
    if (isFinite(deep)) return deep > 0;
    return Array.isArray(brief.picks) && brief.picks.length > 0;
  }

  // 把后端记录的技术原因翻译成零基础也看得懂的话(口径同 tools/research.js aiOutageWording)
  function aiOutageCause(raw) {
    const reason = String(raw == null ? '' : raw);
    if (!reason) return '';
    let why;
    if (/opencode|muse-spark/i.test(reason)) {
      if (/额度|用量|上限|limit/i.test(reason)) why = '免费 AI 用量额度已经用完';
      else if (/超时/.test(reason)) why = '免费 AI 响应超时';
      else if (/认证|登录/.test(reason)) why = '免费 AI 的登录状态失效';
      else if (/未安装|缺少|CLI/i.test(reason)) why = '服务器上缺少免费 AI 运行环境';
      else if (/网络|连接/.test(reason)) why = '免费 AI 连接失败';
      else why = '免费 AI 分析中途出错';
    }
    else if (/额度|用量|上限|限制|limit/i.test(reason)) why = 'AI 模型的用量额度已经用完';
    else if (/超时/.test(reason)) why = 'AI 模型响应超时';
    else if (/认证|登录/.test(reason)) why = 'AI 模型的登录状态失效';
    else if (/未安装|缺少|CLI/.test(reason)) why = '服务器上缺少 AI 运行环境';
    else if (/网络|连接/.test(reason)) why = 'AI 模型连接失败';
    else why = 'AI 分析中途出错';
    const eta = reason.match(/预计[^,，。;；]*恢复/);
    return eta ? why + '，' + eta[0] : why;
  }

  // 后端 v2.2 的说明本身就合格(明说 AI 没跑 + 明说不代表没机会),直接原样用;
  // 老简报里那句「本场仅完成 Static 更新…」两条都不满足,而且带内部黑话,不许照搬。
  function backendOutageTextUsable(text) {
    const s = String(text == null ? '' : text);
    if (!/不代表/.test(s)) return false;
    if (!/AI/.test(s)) return false;
    return !/Static|static_only|深挖|快评|沿用|怀疑者/.test(s);
  }

  // AI 跑成了 → 返回空串(不占版面);没跑成 → 一段必须出现的诚实告示
  function aiOutageBannerHTML(brief) {
    if (!brief || typeof brief !== 'object') return '';
    if (brief.error) return '';                 // 研究失败有自己的红色失败卡
    if (aiRanInBrief(brief)) return '';
    const meta = brief.meta || {};
    const backend = String(brief.no_pick_reason || '');
    const cause = aiOutageCause(meta.fallback_reason);
    const body = backendOutageTextUsable(backend)
      ? backend
      : '今天 AI 未运行' + (cause ? '（' + cause + '）' : '（可能是 AI 的用量额度用完，也可能是运行时出错）') +
        '，所以没有产生新的买入结论。这不代表今天没有值得买的股票，只代表系统今天没能给出判断。' +
        '今天照常完成的是不需要 AI 的部分：全部股票的最新股价、以及完全由固定公式算出的分数已更新。' +
        '页面上带买入/回避方向的行，是以前 AI 分析的结论，每条都标了分析日期；' +
        '分析超过 21 天、或股价比分析当天涨跌超过 10%，该结论会自动作废并重新排队。';
    return '<section class="card static-banner" role="status">' +
      '<div class="static-banner-head"><span class="dot dot-warn"></span>' +
        '<span class="static-banner-title">今天 AI 未运行，没有新的买入结论</span></div>' +
      '<p class="static-banner-text">' + esc(body) + '</p>' +
      '<p class="static-banner-text">因为今天没做出新判断，这一场不会给你发手机通知。</p>' +
    '</section>';
  }

  // 月历格子的标记:AI 没跑成 ≠ 无推荐,这两种日子必须分开(v2.2 A2)。
  // 老索引没有 aiRan 字段时按 staticOnly 推断,与后端 rebuildIndex 同口径。
  function calendarAiRan(it) {
    if (!it || typeof it !== 'object') return false;
    if (typeof it.aiRan === 'boolean') return it.aiRan;
    return !it.staticOnly;
  }

  function markFor(it) {
    if (!it) return { cls: 'mark-none', label: '' };
    if (it.error) return { cls: 'mark-fail', label: '运行失败' };
    if (!calendarAiRan(it)) return { cls: 'mark-static', label: 'AI 未运行 · 无新结论' };
    if (!it.numPicks) {
      // A3:当天无新增买入、但简报 watchlist 里确有观察项(页面正文/持有卡会展示它们)时,
      // 不得写「无合格标的」——那会跟同一天的页面内容自相矛盾。numWatch 由后端
      // rebuildIndex 从简报 watchlist 长度写入(老索引缺该字段时回退旧文案)。
      const w = Number(it.numWatch);
      if (Number.isFinite(w) && Math.floor(w) > 0) {
        return { cls: 'mark-nopick', label: 'AI 已分析 · 无新增买入（' + Math.floor(w) + ' 只观察）' };
      }
      return { cls: 'mark-nopick', label: 'AI 已分析 · 无合格标的' };
    }
    return { cls: 'mark-pick', label: '有推荐' };
  }

  // 每日分析在收盘后生成。前端读不到 config.json,这里用具名常量(与
  // systemd/stock-advisor-daily.timer 及 config.dailyRun 同口径,测试钉住一致)。
  const DAILY_RUN_HHMM = '13:20';

  // 两个 YYYY-MM-DD 的整天差(b - a;正午 UTC 锚点避开 DST)。非法输入 → null。
  // 注意:自带正则,不引用后方浏览器段的 DATE_RE(它在 node 的 early-return 之后,单测够不到)。
  function briefDayDiff(a, b) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(String(a || '')) || !re.test(String(b || ''))) return null;
    return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  }

  // A2:「今天还没有简报」时的今日页说明(纯函数)。briefDate 已是今天 → ''(不占版面);
  // 落后 1 天 → 待生成(正常);落后≥2 天 → 如实说缺失天数。这里只说运营状态:
  // 绝不出现过期告警/运行脚本指令,也不写任何会被读成投资结论的话。
  function briefPendingHTML(briefDate, todayLA) {
    const diff = briefDayDiff(briefDate, todayLA);
    if (diff == null || diff <= 0) return '';
    if (diff === 1) {
      return '<div class="today-pending">今天的分析将在收盘后（' + DAILY_RUN_HHMM +
        ' 洛杉矶时间）生成，当前展示的是 ' + esc(briefDate) + ' 的结论。</div>';
    }
    return '<div class="today-pending">已连续 ' + diff + ' 天没有新的分析（最新 ' +
      esc(briefDate) + '）。今天的分析将在收盘后（' + DAILY_RUN_HHMM +
      ' 洛杉矶时间）生成。</div>';
  }

  /* ---------- 待复核清单(2026-07-28 补上,此前服务端算了但前端从没读) ----------
     服务端 publicLeaderboard 会给「曾经被判为可买入/应回避，但依据已经不满足现行标准」的行
     打上 needs_revalidation=true(server.js 里写入)。这批股票故意不算进「今日行动」——
     没有新证据就不推荐,这条纪律不动。但把它们藏起来是另一种谎:过去 14 天有 12 天
     首页显示「今天无需操作」,而磁盘上其实有 2–22 只处于这个状态。这里单列出来。 */

  // 纯函数:挑出待复核的行。服务端降级时不保留原来的买/卖方向,所以只说「待重新核实」。
  function pendingRevalidationRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter(function (r) {
      return r && typeof r === 'object' && r.needs_revalidation === true;
    });
  }

  // 纯函数:这一行为什么要重新核实——只从行上已有字段推断,推不出就说「依据不完整」。
  function revalidationReason(r, refDate) {
    if (isLegacyConfidence(r)) return '用的是旧版打分方式（满分 10 分），要按现在的 100 分制重算';
    if (r && r.analysis_kind === 'lite') return '只做过快速评估（扫了一遍公开数据），还没做深入研究';
    const age = ageMeta(r && r.analyzed_on, refDate);
    if (age && age.days > 21) return '上一次深入研究已经是 ' + age.days + ' 天前，超过了 21 天的有效期';
    if (!r || !r.analyzed_on) return '没有记录到有效的研究日期，依据不完整';
    return '依据已经不符合现在的标准，等着重新研究';
  }

  // 纯函数:「待复核 N 只 · 不作为今日行动」卡。没有这类行 → ''(不占版面)。
  function pendingRevalidationHTML(rows, opts) {
    opts = opts || {};
    const list = pendingRevalidationRows(rows);
    if (!list.length) return '';
    const refDate = opts.refDate || null;
    const MAX = 30;
    const items = list.slice(0, MAX).map(function (r) {
      const meta = confidencePresentation(r);
      const scoreTxt = meta.value === '还没核实' ? '暂无评分' : meta.label + ' ' + meta.text;
      const age = ageMeta(r.analyzed_on, refDate);
      return '<button class="rev-item" type="button" data-ticker="' +
        esc(String(r.ticker == null ? '' : r.ticker).toUpperCase()) +
        '" aria-label="' + esc(r.ticker) + '，待重新核实，查看详情">' +
        '<span class="rev-id"><b class="rev-ticker">' + esc(r.ticker) + '</b>' +
          (r.name ? '<span class="rev-name">' + esc(r.name) + '</span>' : '') + '</span>' +
        '<span class="rev-why">' + esc(revalidationReason(r, refDate)) + '</span>' +
        '<span class="rev-meta">' + esc(scoreTxt) +
          (age ? ' · ' + esc(age.label) : '') + providerBadgeHTML(r) + '</span>' +
      '</button>';
    }).join('');
    const more = list.length > MAX
      ? '<p class="rev-more">还有 ' + (list.length - MAX) + ' 只，可在下方全市场排行榜里搜索查看。</p>'
      : '';
    return '<section class="card rev-card">' +
      '<details class="rev-details">' +
        '<summary class="rev-sum">' +
          '<span class="dot dot-warn"></span>' +
          '<span class="rev-title">待复核 <b>' + list.length + '</b> 只 · 不作为今日行动</span>' +
          '<span class="lb-caret" aria-hidden="true">›</span>' +
        '</summary>' +
        '<p class="rev-lead">这些股票<b>以前</b>被判断为「可以买入」或「应当回避」，但那个判断现在已经不算数了' +
          '（打分的方式换了，或者结论过期了）。在重新研究出结果之前，系统<b>不会</b>把它们算进今天的建议——' +
          '没有新证据就不推荐。列在这里只是让你知道有这么几只，<b>不是</b>让你现在买或卖。</p>' +
        '<div class="rev-list">' + items + '</div>' + more +
      '</details>' +
    '</section>';
  }

  // 纯函数:各行动档计数 + 行业列表(按出现次数降序),供筛选 chips/下拉显示实时数量。
  function lbFacets(rows) {
    const arr = Array.isArray(rows) ? rows : [];
    const counts = { all: 0, buy: 0, sell: 0, wait: 0, candidate: 0 };
    const secMap = Object.create(null);
    arr.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      counts.all += 1;
      counts[rowAction(r)] += 1;
      const s = String(r.sector || '');
      if (s) secMap[s] = (secMap[s] || 0) + 1;
    });
    const sectors = Object.keys(secMap)
      .map(function (s) { return { sector: s, n: secMap[s] }; })
      .sort(function (a, b) { return b.n - a.n || (a.sector < b.sector ? -1 : 1); });
    return { counts: counts, sectors: sectors };
  }

  // 纯函数:在行数组中按 ticker(不分大小写)定位下标;未命中返回 -1。
  // 供「今日建议买」strip 点击时,在统一榜单中定位对应行(展开 + 滚动)。
  function locateTicker(rows, ticker) {
    if (!Array.isArray(rows)) return -1;
    const t = String(ticker == null ? '' : ticker).toUpperCase();
    if (!t) return -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && String(r.ticker == null ? '' : r.ticker).toUpperCase() === t) return i;
    }
    return -1;
  }

  // rejected 可能只是观察名单名额外/价格不够低；只有显式 killed 才是 avoid。
  function rosterStatusToCall(status, row) {
    if (status === 'pick') return 'buy';
    if (status === 'watch') return 'watch';
    if (status === 'rejected' && row
      && (row.killed === true || /^怀疑者否决[:：]/.test(String(row.decision || '')))) return 'avoid';
    if (status === 'rejected') return 'watch';
    return null;
  }

  // 纯函数:把 brief.roster 映射成「榜单行」结构(无 leaderboard 数据时的回退)。
  // 只带榜单主行需要的字段;无 score/band/score_parts → 评分与分解面板优雅跳过。
  function rosterAsRows(roster) {
    const arr = Array.isArray(roster) ? roster : [];
    const out = [];
    arr.forEach(function (r, i) {
      if (!r || typeof r !== 'object') return;
      out.push({
        rank: (r.rank != null && r.rank !== '') ? r.rank : (i + 1),
        ticker: r.ticker,
        name: r.name,
        sector: r.sector || '',
        score: firstNum(r.score),
        band: r.band || null,
        deep: r.analyzed === 'deep',
        call: (r.analyzed === 'deep') ? rosterStatusToCall(r.status, r) : null,
        conviction: r.conviction,
        confidence_level: r.confidence_level,
        confidence_source: r.confidence_source,
        confidence_scale: r.confidence_scale,
        analysis_kind: r.analysis_kind || null,
        analyzed_on: r.analyzed_on || null,
        reason: r.decision || ''
      });
    });
    return out;
  }

  // 纯函数:增量渲染分页——取前 limit 行,并给出是否还有更多、总数
  function sliceForRender(rows, limit) {
    const arr = Array.isArray(rows) ? rows : [];
    let n = Math.floor(Number(limit));
    if (!isFinite(n) || n < 0) n = 0;
    return { items: arr.slice(0, n), hasMore: arr.length > n, total: arr.length };
  }

  // 纯函数:统计 { screened, deep, buy }——筛查数 / 深析数 / 建议买数
  function leaderboardCounts(lb) {
    const rows = (lb && Array.isArray(lb.rows)) ? lb.rows : [];
    const cn = Number(lb && lb.count);
    const screened = isFinite(cn) ? cn : rows.length;
    let deep = 0, buy = 0;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      if (r.deep) deep += 1;
      if (rowAction(r) === 'buy') buy += 1;
    });
    return { screened: screened, deep: deep, buy: buy };
  }

  // band → { 修饰类, 色点类, 文字标签 }(双通道:色 + 文字,不靠颜色单独表意)
  // band 三档随建议度:≥60 green(建议买区,只有过门槛的深析行能到)/ ≥40 yellow / 其余 red
  function bandMeta(band) {
    if (band === 'green') return { cls: 'lb-band--green', dot: 'dot-good', label: '高' };
    if (band === 'yellow') return { cls: 'lb-band--yellow', dot: 'dot-warn', label: '中' };
    if (band === 'red') return { cls: 'lb-band--red', dot: 'dot-crit', label: '低' };
    return { cls: 'lb-band--none', dot: 'dot-none', label: '—' };
  }

  // AI call → { 修饰类, 色点类, 文字标签, 符号 };未知 call 返回 null
  function callMeta(call) {
    if (call === 'buy') return { cls: 'lb-call--buy', dot: 'dot-good', label: '值得关注', sym: '✓' };
    if (call === 'watch') return { cls: 'lb-call--watch', dot: 'dot-warn', label: '继续等待', sym: '' };
    if (call === 'avoid') return { cls: 'lb-call--avoid', dot: 'dot-crit', label: '不建议买', sym: '✗' };
    return null;
  }

  // v2.0 行动 chip 只表达方向；1–100 买入把握分在独立数值列展示，避免两种含义挤在一起。
  function actionMeta(row) {
    if (row.action === 'buy') return { cls: 'lb-call--buy', dot: 'dot-good', label: '↑ 值得关注' };
    if (row.action === 'sell') return { cls: 'lb-call--avoid', dot: 'dot-crit', label: '↓ 建议回避' };
    if (row.action === 'wait') return { cls: 'lb-call--watch', dot: 'dot-warn', label: '→ 继续等待' };
    return null;
  }

  // AI 徽章 HTML:优先 v2.0 行动 chip；旧数据回落到 call 三档；非深挖 → 候选弱文。
  function callBadgeHTML(row) {
    const action = rowAction(row);
    if (action === 'candidate') {
      return row && row.deep
        ? '<span class="chip lb-call lb-call--none"><span class="dot dot-none"></span>AI 研究过了</span>'
        : '<span class="lb-undeep">◇ 排队中 · AI 还没研究</span>';
    }
    const am = actionMeta({ action: action });
    if (am) {
      return '<span class="chip lb-call ' + am.cls + '"><span class="dot ' + am.dot + '"></span>' +
        esc(am.label) + '</span>';
    }
    return '<span class="chip lb-call lb-call--none"><span class="dot dot-none"></span>AI 研究过了</span>';
  }

  // 分数色条:宽度 = 分数(0-100),填充取 band 色(色条,与 band 色点互补)
  function lbScoreBarHTML(score, band) {
    let n = Number(score);
    if (!isFinite(n)) n = 0;
    n = Math.max(0, Math.min(100, n));
    const m = bandMeta(band);
    return '<div class="lb-bar" aria-hidden="true"><i class="lb-bar-fill ' + m.cls + '" style="width:' + n + '%"></i></div>';
  }

  // 单行排行卡(纯字符串)。全部 500 行皆为 <details> 可点开:summary=主行数据(reason 移入展开体);
  // 展开体 lazy(空占位,展开时才由 leaderboardRowBodyHTML 填充)。uid 供 deep 行走势图渐变去重。
  function leaderboardRowHTML(row, uid, why, refDate) {
    if (!row || typeof row !== 'object') return '';
    const isDeep = !!row.deep;
    const action = rowAction(row);
    const isAction = action === 'buy' || action === 'sell';
    const isPriority = isAction && row.cached !== true && row.analyzed_on === refDate;
    // AI 结论年龄直接标在行上(不用点开):今天/昨天/N天前;买入行附 ✓(失效当日优先复核)
    let ageHTML = '';
    if (isDeep) {
      const am = ageMeta(row.analyzed_on, refDate);
      if (am) {
        const guard = rowAction(row) === 'buy' ? ' ✓' : '';
        ageHTML = '<span class="lb-age ' + am.cls + '" title="AI 是在 ' + esc(row.analyzed_on) + ' 研究的">' +
          esc(am.label) + guard + '</span>';
      }
    }
    const rank = (row.rank != null && row.rank !== '') ? row.rank : '';
    const confidence = rowBuyConfidence(row);
    const confidenceMeta = confidencePresentation(row);
    const legacyConfidence = confidenceMeta.legacy;
    const scoreN = Number(row.score);
    const shownScore = isDeep ? confidence : scoreN;
    const shownBand = isDeep && isFinite(shownScore)
      ? (shownScore >= 60 ? 'green' : shownScore >= 40 ? 'yellow' : 'red')
      : row.band;
    const bm = bandMeta(shownBand);
    const scoreTxt = isDeep ? confidenceMeta.value
      : (isFinite(shownScore) ? String(Math.round(shownScore)) : '还没核实');
    const scoreLabel = isDeep
      ? (confidenceMeta.label + (legacyConfidence ? ' · 待重算' : ''))
      : '电脑估分';
    const scoreDenom = isDeep
      ? (confidenceMeta.denom ? '<small>' + esc(confidenceMeta.denom) + '</small>' : '')
      : (isFinite(shownScore) ? '<small>/100</small>' : '');
    const focusHTML = isPriority ? '<span class="lb-focus-tag">重点</span>' : '';
    const nameHTML = row.name ? '<span class="lb-name">' + esc(row.name) + '</span>' : '';
    const sectorHTML = row.sector ? '<div class="lb-id-sub"><span class="lb-sector">' + esc(row.sector) + '</span></div>' : '';
    const bandChip = '<span class="chip lb-band ' + bm.cls + '"><span class="dot ' + bm.dot + '"></span>' + esc(bm.label) + '</span>';
    const main =
      '<div class="lb-row-main">' +
        '<span class="lb-rank">#' + esc(rank) + '</span>' +
        '<div class="lb-id">' +
          '<div class="lb-id-top"><span class="lb-ticker">' + esc(row.ticker) + '</span>' + focusHTML + nameHTML + '</div>' +
          sectorHTML +
        '</div>' +
        '<div class="lb-score-wrap">' +
          '<div class="lb-score-label">' + scoreLabel + '</div>' +
          '<div class="lb-score">' + esc(scoreTxt) + scoreDenom + '</div>' +
          lbScoreBarHTML(shownScore, shownBand) +
          bandChip +
        '</div>' +
        '<div class="lb-right"><div class="lb-right-col">' + callBadgeHTML(row) + ageHTML +
          providerBadgeHTML(row) + '</div><span class="lb-caret" aria-hidden="true">›</span></div>' +
      '</div>';
    const du = uid ? ' data-uid="' + esc(uid) + '"' : '';
    const dt = ' data-ticker="' + esc(String(row.ticker == null ? '' : row.ticker).toUpperCase()) + '"';
    // why:AI 一句话结论(深挖行)——让「分高但不建议」不点开也能看到原因
    const whyHTML = why ? '<div class="lb-why">' + esc(why) + '</div>' : '';
    const actionCls = isAction ? ' lb-row--attention lb-row--action-' + action : '';
    const priorityCls = isPriority ? ' lb-row--priority' : '';
    return '<details class="lb-row lb-row--' + (isDeep ? 'deep' : 'scan') + actionCls + priorityCls + '"' + du + dt + '>' +
      '<summary class="lb-sum">' + main + whyHTML + '</summary>' +
      '<div class="lb-body"></div>' +
    '</details>';
  }

  // 排行榜展开体(纯字符串,lazy 生成)。deep 行=AI 全分析(平铺);其余=量化评分卡 + reason + 「未深度分析」弱文。
  // 排行榜行本身只带量化字段与 call;AI 文字/market_data 在 brief.roster,故 deep 行由调用方按 ticker 传入
  // rosterItem(深挖项)合并渲染;量化条恒用排行榜行字段(opts.row)。
  // weights = leaderboard.weights(供评分分解面板的方法说明动态读权重;缺失面板仍可渲染,方法说明回退默认百分比)。
  // 评分分解面板恒置于量化条上方;row.score_parts 缺失(旧数据/回退)时面板整块跳过。
  function leaderboardRowBodyHTML(row, uid, rosterItem, weights) {
    if (!row || typeof row !== 'object') return '';
    const sb = scoreBreakdownHTML(row, weights, row.quant_score != null ? row.quant_score : row.score);
    // 由哪个 AI 得出的结论,展开体里也如实写一行(字段缺失就不写,绝不默认写成 Claude)
    const prov = providerOf(row) === 'gpt'
      ? '<p class="lb-prov-note">这条结论由 Codex/GPT 产出；历史 Claude 结论会保留各自的来源标记。</p>'
      : (providerOf(row) === 'opencode'
        ? '<p class="lb-prov-note">这条结论由免费 AI（OpenCode 免费模型）产出；不同 AI 的结论会保留各自的来源标记。</p>'
        : '');
    if (row.deep && rosterItem && typeof rosterItem === 'object') {
      const p = Object.assign({}, row, rosterItem);
      return prov + pickDetailHTML(p, uid, { flat: true, memo: true, row: row, scoreBreakdown: sb });
    }
    const q = quantBarsHTML(row);
    const reason = row.reason ? '<div class="lb-reason">' + esc(row.reason) + '</div>' : '';
    // ---- 2026-07-30:时间尺度标签(用户要求「要清晰易懂,长期还是短期」)----
    // 后端 tools/research.js 写 row.horizon / row.horizon_label。
    // 关键点:这个 App **没有可用的短期信号** —— 全域搜索确认短期机会的打平成本只有
    // 7.9–11.2bps,手续费会吃光,所以不做。所以这里只有「长期」和「未研究」两种,
    // 不许为了界面丰富而编一个「短期」出来(test/plain-language.test.js 锁着这条)。
    const horizonHTML = row.horizon_label
      ? '<div class="lb-horizon lb-horizon--' + esc(row.horizon || 'none') + '">'
        + '这条结论看的是：<b>' + esc(row.horizon_label) + '</b>'
        + (row.horizon === 'none'
          ? '（下面几句只是描述现在的股价位置，不是买卖建议）'
          : '（下面的股价描述说的是眼下的位置，跟这个 3 年判断是两回事）')
        + '</div>'
      : '';
    if (row.deep) {
      // 缓存沿用行(或当日 roster 缺失):一句话论点 + 分析日期,全文在当日简报
      const note = row.ai_note ? '<div class="lb-reason">' + esc(plainifyAiNote(row.ai_note)) + '</div>' : '';
      const on = row.analyzed_on
        ? (row.analysis_kind === 'lite'
          // 黑话改人话:快评/深挖/轻量初评/买入权限 → 用户看不懂
          ? '<p class="lb-undeep-note">这是 ' + esc(row.analyzed_on) + ' 做的<b>快速评估</b>（只扫了一遍公开数据，没有深入研究，所以不会给出买入结论）。如果快速评估看着不错，系统会自动排队做深入研究。</p>'
          : '<p class="lb-undeep-note">这是 ' + esc(row.analyzed_on) + ' 做的<b>深入研究</b>，结论还在有效期内。股价大幅变动或结论过期后会自动重新研究。完整分析在那天的简报里。</p>')
        : '';
      return prov + horizonHTML + note + sb + q + reason + on;
    }
    return horizonHTML + sb + q + reason
      + '<p class="lb-undeep-note">这只还<b>没做过深入研究</b>，上面只是电脑按公开股价算出来的情况。它在排队等待研究。</p>';
  }

  // 纯函数:排行榜行 lazy 填充判定——已打开且尚未填充过才填充
  function lbShouldFill(isOpen, filled) { return !!isOpen && !filled; }

  // 顶部图例(常显,一行看懂符号)+ 长说明折叠(默认收起——首屏不再是字墙,想深究再点开)
  function leaderboardExplainerHTML() {
    return '<section class="card lb-explain">' +
      '<div class="lb-legend">' +
        '<div class="lb-legend-group">' +
          '<span class="chip lb-call lb-call--buy"><span class="dot dot-good"></span>↑ 值得关注</span>' +
          '<span class="chip lb-call lb-call--avoid"><span class="dot dot-crit"></span>↓ 建议回避</span>' +
          '<span class="chip lb-call lb-call--watch"><span class="dot dot-warn"></span>→ 继续等待</span>' +
          '<span class="lb-legend-item">◇ 排队中=AI 还没研究过,不是说它会跌</span>' +
        '</div>' +
      '</div>' +
      '<details class="lb-explain-more">' +
        '<summary>❓ 怎么读这个榜单</summary>' +
        '<p class="lb-explain-lead"><b>方向和分数是两回事,分开看</b>:↑ 表示 AI 研究后认为值得关注；' +
          '↓ 表示那个专门挑毛病的 AI 找到了伤及三五年前景的硬伤，明确要求回避；→ 表示先等等。' +
          '大数字是 <b>1–100 的「买入理由完整度」</b>：分高表示买它的理由被查证得比较完整，分低只表示<b>现在不适合买</b>，' +
          '<b>并不等于它会跌</b>。' + CONFIDENCE_CAVEAT +
          '排序上，值得关注和建议回避排在最前面；值得关注的按理由完整度从高到低，建议回避的按分低的先排（分越低越该先看一眼），' +
          '然后是继续等待，最后是还在排队的。AI 还没研究过的标「◇ 排队中」，只显示电脑估分。' +
          '全部 500 只每天三场都由固定算法重新算一遍、重新排队（这一步不花 AI 额度）；每场挑 12 只交给 AI 做深入研究，' +
          '一条结论最多用 21 天（股价涨跌超过 10% 就提前作废、重新研究）。' +
          '行右边的「今天 / N 天前」是这条 AI 结论是哪天做的，超过 14 天会变黄提醒；' +
          '标着 ✓ 的是「值得关注」那一档，股价一有大波动当天就会被排到最前面重新研究。' +
          '颜色:🟢 高(60 分以上)/ 🟡 中(40–59)/ 🔴 低(40 分以下)。每一行都能点开看依据。</p>' +
        // RUBRIC v2.4 §0:榜单是用户最常看的地方,这条不能只藏在算法页里。
        '<p class="lb-explain-lead lb-explain-warn"><b>这个排名没有被证明能选出跑赢大盘的股票。</b>' +
          '历史检验里,按本榜单前 20 名买入、往后一年跑赢标普500的比例只有 43%,分数分档后也看不出「越高越好」。' +
          '同时样本只有约 12 年,只够查出「每年多赚 10 个百分点以上」的大效果,所以也<b>不能反过来说它没用</b>。' +
          '这个排名真正的用处,是决定 AI 今天先研究哪几只;请把它当线索,不要当买卖指令。完整数据见底部「算法」页。</p>' +
      '</details>' +
    '</section>';
  }

  // 计数条:今日筛查 N 只 · 深度分析 M 只 · 建议买 K 只
  function leaderboardCountsHTML(counts) {
    const c = counts || {};
    const n = isFinite(Number(c.screened)) ? Number(c.screened) : 0;
    const m = isFinite(Number(c.deep)) ? Number(c.deep) : 0;
    const k = isFinite(Number(c.buy)) ? Number(c.buy) : 0;
    return '<p class="lb-counts">今天电脑算过 <b>' + esc(n) + '</b> 只 · 已有 AI 结论 <b>' + esc(m) +
      '</b> 只 · 值得关注 <b>' + esc(k) + '</b> 只</p>';
  }

  // 搜索框 + 行动档过滤芯片(与行上行动 chip 同口径,带实时计数)+ 行业下拉。
  // 芯片:全部 | ↑买入 | ↓回避复核 | →等待 | ◇候选;计数让用户不用点也知道每档有几只。
  // facets = lbFacets(rows);缺省则芯片无计数、下拉只有「全部行业」。
  function leaderboardControlsHTML(facets) {
    const fc = (facets && facets.counts) || {};
    const n = function (k) { return isFinite(Number(fc[k])) ? ' ' + Number(fc[k]) : ''; };
    const defs = [
      { f: 'all', label: '全部' + n('all'), aria: '全部' },
      { f: 'buy', label: '↑ 值得关注' + n('buy'), aria: '只看 AI 认为值得关注的' },
      { f: 'sell', label: '↓ 建议回避' + n('sell'), aria: '只看 AI 明确要求回避的' },
      { f: 'wait', label: '→ 继续等待' + n('wait'), aria: '只看 AI 建议先等等的' },
      { f: 'candidate', label: '◇ 排队中' + n('candidate'), aria: '只看 AI 还没研究过、还在排队的' }
    ];
    const chips = defs.map(function (d) {
      const on = d.f === 'all';
      return '<button class="lb-chip' + (on ? ' on' : '') + '" type="button" role="tab" data-filter="' + esc(d.f) +
        '" aria-selected="' + (on ? 'true' : 'false') + '" aria-label="' + esc(d.aria) + '">' + esc(d.label) + '</button>';
    }).join('');
    const secs = (facets && Array.isArray(facets.sectors)) ? facets.sectors : [];
    const secOpts = ['<option value="all">全部行业</option>'].concat(secs.map(function (s) {
      return '<option value="' + esc(s.sector) + '">' + esc(s.sector) + '(' + esc(s.n) + ')</option>';
    })).join('');
    return '<div class="lb-controls">' +
      '<div class="lb-controls-row">' +
        '<input class="lb-search-input" type="search" inputmode="search" placeholder="搜索代码或名称" aria-label="搜索代码或名称">' +
        (secs.length ? '<select class="lb-sector-sel" aria-label="按行业筛选">' + secOpts + '</select>' : '') +
      '</div>' +
      '<div class="lb-chips" role="tablist">' + chips + '</div>' +
    '</div>';
  }

  // 「今日值得关注」紧凑 strip(纯字符串):每项 = 色点(绿)+ ticker + 买入理由完整度(N/100)。
  // picks 为空或全无有效 ticker → 返回空串(调用方据此回退「今日无推荐」卡)。
  function todayPicksStripHTML(picks) {
    const arr = Array.isArray(picks) ? picks : [];
    const items = [];
    arr.forEach(function (p) {
      if (!p || typeof p !== 'object' || p.ticker == null || p.ticker === '') return;
      const confidence = rowBuyConfidence(p);
      const convTxt = confidence == null ? '' : confidence + '/100';
      items.push('<button class="pk-item" type="button" data-ticker="' + esc(String(p.ticker).toUpperCase()) + '">' +
        '<span class="dot dot-good"></span>' +
        '<span class="pk-ticker">' + esc(p.ticker) + '</span>' +
        (convTxt ? '<span class="pk-score">' + esc(convTxt) + '</span>' : '') +
      '</button>');
    });
    if (!items.length) return '';
    return '<section class="card picks-strip">' +
      '<span class="pk-lead" title="' + esc(CONFIDENCE_CAVEAT) + '">今天值得关注</span>' +
      '<div class="pk-items">' + items.join('<span class="pk-sep" aria-hidden="true">·</span>') + '</div>' +
    '</section>';
  }

  /* ==================== 审计卡(每 3 天;动作②:评分标准自检,纯字符串) ==================== */

  function auditIssueMeta(issue) {
    if (issue === 'underrated') return { dot: 'dot-good', label: '被低估' };
    if (issue === 'overrated') return { dot: 'dot-crit', label: '虚高' };
    return { dot: 'dot-warn', label: '不一致' };
  }

  // 审计卡:结论(keep chip + verdict)+ 问题标记 details + 改进建议 details。audit 无效 → ''。
  function auditCardHTML(a) {
    if (!a || typeof a !== 'object') return '';
    const rr = a.rubric_review || {};
    const flags = Array.isArray(a.flags) ? a.flags : [];
    if (!rr.verdict && !flags.length) return '';
    const keepChip = rr.keep === false
      ? '<span class="chip roster-chip--rejected"><span class="dot dot-crit"></span>需修订</span>'
      : '<span class="chip roster-chip--pick"><span class="dot dot-good"></span>标准可留用</span>';
    let counts = { underrated: 0, overrated: 0, inconsistent: 0 };
    flags.forEach(function (f) { if (f && counts[f.issue] != null) counts[f.issue]++; });
    const flagRows = flags.map(function (f) {
      if (!f || !f.ticker) return '';
      const m = auditIssueMeta(f.issue);
      return '<div class="audit-flag"><span class="dot ' + m.dot + '"></span><b>' + esc(f.ticker) + '</b>' +
        '<span class="audit-flag-issue">' + esc(m.label) + '</span> ' + esc(f.why || '') + '</div>';
    }).join('');
    const sugRows = (Array.isArray(rr.suggestions) ? rr.suggestions : []).map(function (s) {
      if (!s || !s.change) return '';
      return '<div class="audit-sug">[置信:' + esc(s.confidence || '—') + '] ' + esc(s.change) +
        (s.expected ? ' <span class="audit-sug-exp">→ ' + esc(s.expected) + '</span>' : '') + '</div>';
    }).join('');
    const weak = (Array.isArray(rr.weaknesses) ? rr.weaknesses : []).map(function (w) {
      return '<li>' + esc(w) + '</li>';
    }).join('');
    return '<section class="card audit-card">' +
      '<div class="block-title">🔍 定期审计(每 3 天 · 评分标准自检)' + (a.date ? ' · ' + esc(a.date) : '') + '</div>' +
      '<div class="audit-head">' + keepChip + '</div>' +
      (rr.verdict ? '<p class="sec-body">' + esc(rr.verdict) + '</p>' : '') +
      (flags.length
        ? '<details class="audit-details"><summary>问题标记 ' + flags.length + ' 条(被低估 ' + counts.underrated +
          ' · 虚高 ' + counts.overrated + ' · 不一致 ' + counts.inconsistent + ');被低估的自动插队进深挖队列</summary>' +
          flagRows + '</details>'
        : '') +
      (weak ? '<details class="audit-details"><summary>标准缺陷 ' + (rr.weaknesses || []).length + ' 条</summary><ul class="audit-weak">' + weak + '</ul></details>' : '') +
      (sugRows ? '<details class="audit-details"><summary>改进建议 ' + (rr.suggestions || []).length + ' 条(只建议,采纳需人工升 RUBRIC 版本)</summary>' + sugRows + '</details>' : '') +
      '<p class="audit-note">高级模型每日自动对照 RUBRIC 评分标准扫全表 + 复核历史战绩;原始文件 data/audit/。</p>' +
    '</section>';
  }

  // 纯函数:是否显示「回到今日」——浏览简报视图,所选日期合法且非最新日期时显示。
  function shouldShowBackToToday(selectedDate, latestDate) {
    if (!selectedDate || !latestDate) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return false;
    return selectedDate !== latestDate;
  }

  // 纯函数:从 URL 清掉 date 查询参数,返回新 URL 字符串(replaceState 用);解析失败原样返回。
  function urlWithoutDate(href) {
    try {
      const u = new URL(href);
      u.searchParams.delete('date');
      return u.toString();
    } catch (e) {
      return href;
    }
  }

  // 简报页排行榜入口卡(纯字符串):📊 今日全市场排行榜 · N 只 · 前 M 名已深析 · 建议买 K
  function leaderboardEntryHTML(lb) {
    const c = leaderboardCounts(lb);
    return '<section class="card leaderboard-entry" id="leaderboardEntry" role="button" tabindex="0" aria-label="查看今日全市场排行榜">' +
      '<div class="leaderboard-entry-head">' +
        '<span class="leaderboard-entry-title">📊 今日全市场排行榜</span>' +
        '<span class="leaderboard-entry-count">' + esc(c.screened) + ' 只</span>' +
      '</div>' +
      '<p class="leaderboard-entry-sub">' + esc(c.deep) + ' 只已有 AI 结论 · 值得关注 ' + esc(c.buy) + '</p>' +
    '</section>';
  }

  function formatMarketAsOf(value) {
    const d = new Date(value || '');
    if (!isFinite(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'America/Los_Angeles',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = function (type) {
      const p = parts.find(function (x) { return x.type === type; });
      return p ? p.value : '';
    };
    return get('month') + '/' + get('day') + ' ' + get('hour') + ':' + get('minute') + ' PT';
  }

  // 市场卡必须把时点说清楚：live=true 仍是延迟行情；简报内置值则明确是快照。
  function marketFreshnessHTML(mo) {
    if (!mo || typeof mo !== 'object') return '';
    const when = formatMarketAsOf(mo.asOf);
    const kind = mo.live ? '最新延迟行情' : '简报行情快照';
    const mixed = mo.mixedAsOf ? ' · 各指数时间不完全一致' : '';
    return '<p class="mkt-asof">' + esc(kind) + (when ? ' · 截至 ' + esc(when) : '') +
      ' · 涨跌相对上一交易日收盘' + mixed + '</p>';
  }

  /* ==================== 算法说明(评分怎么算出来的,大白话) ==================== */
  // 纯静态页,不依赖任何接口数据,底部菜单常驻。文案口径必须与后端评分代码一致
  // (RUBRIC.md + tools/{screen,fundamentals,research}.js);算法一改,此页与 RUBRIC.md 同步更新。

  function methodBandRow(dot, name, range, desc) {
    return '<div class="mtd-band">' +
      '<span class="dot ' + dot + '"></span>' +
      '<span class="mtd-band-name">' + esc(name) + '</span>' +
      '<span class="mtd-band-range">' + esc(range) + '</span>' +
      '<p class="mtd-band-desc">' + esc(desc) + '</p>' +
    '</div>';
  }

  function methodStep(n, title, lead, factors, foot) {
    const fx = (factors || []).map(function (f) {
      return '<li><b>' + esc(f[0]) + '</b>' + (f[1] ? '——' + esc(f[1]) : '') + '</li>';
    }).join('');
    return '<div class="mtd-step">' +
      '<div class="mtd-step-head"><span class="mtd-num">' + n + '</span>' +
        '<span class="mtd-step-title">' + esc(title) + '</span></div>' +
      (lead ? '<p class="sec-body">' + esc(lead) + '</p>' : '') +
      (fx ? '<ul class="mtd-factors">' + fx + '</ul>' : '') +
      (foot ? '<p class="mtd-foot">' + esc(foot) + '</p>' : '') +
    '</div>';
  }

  function simpleMethodHTML() {
    return '<section class="card simple-method-lead">' +
      '<span class="simple-kicker">先说结论</span>' +
      '<h2>没有选股分数。</h2>' +
      '<p>我们<b>没有证据表明能帮你跑赢标普 500</b>；同时样本也不足以证明它没用。' +
      '所以不再调权重，也不拿 AI 的 1–10 主观信心参与选股排名或买入门槛。</p>' +
      '<div class="simple-proof"><b>最后一个候选公式</b><span>12个月少赚 1.82%</span>' +
      '<span>跑赢比例 30.22%</span><span>170 个检验，0 个通过</span></div>' +
      '<p class="simple-muted">这是旧算法失败后的事后体检，不是预先登记的新发现。基准为含分红的标普 500。</p>' +
      '</section>' +
      '<section class="card simple-method">' +
      '<span class="simple-kicker">现在怎么做</span><h2>三步，只有三档结论</h2>' +
      '<ol class="simple-steps">' +
      '<li><b>固定轮换</b><span>每天研究 3 家。先复核旧结论，再按公司规模和多久没研究来排队；不靠涨跌预测决定先研究谁。</span></li>' +
      '<li><b>正反两轮</b><span>第一轮和反方复核都只能选：通过、等待、回避；同时分别写明未来 1 个月、1 年、3—5 年的方向。</span></li>' +
      '<li><b>年度复核</b><span>两轮都通过、价格合理、财报资料足够，才进最多 20 家的关注名单；不因短期涨跌自动交易。</span></li>' +
      '</ol></section>' +
      '<section class="card simple-engine"><span class="simple-kicker">谁在研究</span>' +
      '<p>每天的深入研究由免费 AI（OpenCode 免费模型）完成，不花模型费用；每条结论照常附上它查过的资料链接，你可以点开自己核对。结论来源以每条标记为准。AI 生成，仅供参考，不构成投资建议。</p></section>' +
      '<section class="card simple-gate">' +
      '<span class="simple-kicker">什么时候通过</span>' +
      '<div class="simple-gate-row"><b>通过</b><span>第一轮通过 + 反方通过 + 当前价格合理 + 财报至少 3/4 项完整</span></div>' +
      '<div class="simple-gate-row"><b>等待</b><span>证据不足、价格不合适、旧结论未复核，或任一轮要求等待</span></div>' +
      '<div class="simple-gate-row"><b>回避</b><span>有真实来源证明长期逻辑受损；短期坏消息不够</span></div>' +
      '</section>' +
      '<section class="card simple-boundary"><b>边界</b>' +
      '<p>AI 三档判断还没有足够的真实前向样本，不能说已经通过回测。系统会继续按结论当天的价格追踪，并和标普 500 比较。</p>' +
      '<p>1–10 信心只表示 AI 自己认为证据有多完整，不是“上涨概率”；1 个月方向尤其容易错，证据冲突时必须写“方向不明”。</p>' +
      '<p>如果 <b>AI 未运行</b>，页面会明说“今天没有做 AI 分析”。这不代表今天没有值得买的股票；系统故障不等于市场结论，也不给你发手机通知。</p>' +
      '</section>' +
      '<p class="mtd-version">评分标准 v3.7 · 无选股分数 · 三期限方向与主观信心仅供参考，不构成投资建议。</p>';
  }

  // v3.2 新增：方向参考层说明（纯函数，可单测）。方向只看现状、不预测涨跌。
  function v32MethodHTML() {
    // 架构图是给用户看的可视化版本(public/architecture.html),方法页给一个入口
    return '<section class="card simple-v32">' +
      '<span class="simple-kicker">v3.2/v3.3/v3.4/v3.5/v3.6/v3.7 新增</span><h2>今日行动、方向、持仓风险、分层验证</h2>' +
      '<ol class="simple-steps">' +
      '<li><b>今日行动</b><span>把新增买入、持仓复核、年度卖出复核合成一张清单。当天 AI 没完成研究时明确写“今天不新增仓位”，但不会把它说成“市场没有机会”；每行都标原因和数据来源。</span></li>' +
      '<li><b>买入门健康度</b><span>“今天怎么做”里新增一行：公开财报覆盖了多少只、门下多少只、覆盖最低的三个行业。缺数据会明确标成缺数据，不会把“没覆盖”说成“没机会”。v3.5 起银行与准则切换公司的近年营收可被识别;v3.6 起净利润长债资本开支同理,覆盖只增不减;算法规则不变,分数随补齐年份如实重算。</span></li>' +
      '<li><b>公开财报数据</b><span>每天研究前先把全市场的公开财报数据续期一次，再据此计算“财报至少能算出 3/4 项指标”这道买入闸门；读不到就按“算不出”处理，不会把没有数据当成合格，也不会因为本地数据过期就把整张榜单悄悄关掉。</span></li>' +
      '<li><b>市场方向</b><span>每天用代码算 5 个现状信号（长期趋势、市场宽度、近月动量、恐慌指数、整体回撤），' +
      '给出顺风 / 常态 / 逆风。它只刻画现在是什么状态，不预测涨跌，不参与选股，AI 故障时照常有。</span></li>' +
      '<li><b>持仓风险</b><span>名单里的股票按浮动分三级：正常持有 / 跌超10%复核论点 / 跌超20%重点复核。' +
      '分级只决定复核优先级，不自动卖出，365天锁仓纪律不变。跌到复核线会<strong>单独推一条手机提醒</strong>' +
      '（同一天只提醒一次，同一档位不重复；这条提醒不看 AI 跑没跑成）。' +
      '每只持仓还会标出<strong>锁仓到哪天</strong>：持有满 365 天后才会提醒你可以按纪律重新评估是否继续持有——' +
'这是卖出侧唯一的合规时点，系统不会自动卖，也不会因为跌了就让你割肉。</span></li>' +
      '<li><b>分层验证</b><span>过去的结论按“买入组 / 观察组”分别统计跑赢大盘的比例，' +
      '数字每月如实更新，好坏都展示。</span></li>' +
      '</ol>' +
      '<p class="simple-muted">这些观察与整理工具都没有跑赢大盘的证据，同样不构成投资建议。</p>' +
      '<p class="simple-muted">方向层的判断会每天记进账本（含当时的指数点位），攒够样本后在方向卡里对照「当时什么状态、之后市场怎么走」——' +
      '样本不够就只报条数，平均值不给。' +
      '入选当天的论点会原文冻结在名单里，复核时读的是原文，不是被后来结论改写的版本。' +
      '查看<a href="/architecture.html" target="_blank" rel="noopener noreferrer">系统架构图</a>。</p>' +
      '<p class="mtd-version">' +
      '行动中心 v1 · 论点复核包 v1（v3.7，只摆事实） · 买入门健康度 v1（v3.4，v3.7 扩覆盖） · 方向参考 v1 · 持仓风险 v1 · 分层验证 v1 · 风险提醒 v1 · 论点快照 v1 · 锁仓时间线 v1（2026-09-26 冻结，前向追踪中）。</p></section>';
  }

  // v3.2 今日行动中心（纯函数）：后端只整理既有规则，前端不自行推导买卖结论。
  function actionCenterHTML(action) {
    if (!action || typeof action !== 'object' || !action.buy || !action.review || !action.sell) {
      return '<section class="card action-center" id="v32-actions-card">' +
        '<div class="block-title">今天怎么做</div>' +
        '<p class="sec-body">行动清单暂缺，请参考下方市场方向和持仓风险。</p></section>';
    }
    const pct = function (v) {
      if (v == null || !isFinite(Number(v))) return '—';
      const n = Number(v);
      return (n >= 0 ? '+' : '') + n + '%';
    };
    const tickers = function (items, withDrift) {
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) return '';
      return '<p class="action-tickers">' + arr.map(function (x) {
        return '<b>' + esc(x.ticker || '—') + '</b>' +
          (withDrift ? ' ' + esc(pct(x.drift_pct)) :
            (x.entry_price == null ? '' : ' $' + esc(x.entry_price)));
      }).join('<span aria-hidden="true"> · </span>') + '</p>';
    };
    const row = function (cls, block, extra, sourceText) {
      return '<div class="action-row action-row--' + cls + '">' +
        '<div class="action-label">' + esc(block.label || '') + '</div>' +
        '<div class="action-copy"><b>' + esc(block.headline || '') + '</b>' +
        '<p>' + esc(block.detail || '') + '</p>' + (extra || '') +
        '<p class="action-source">来源：' + esc(sourceText) + '</p></div></div>';
    };
    const gateRow = function (gate) {
      if (!gate || typeof gate !== 'object' || !gate.label) return '';
      const miss = Array.isArray(gate.missing) ? gate.missing.slice(0, 18) : [];
      const missLine = miss.length ? '<p class="action-tickers">' + miss.map(function (m) {
        return '<b>' + esc(m.ticker || '—') + '</b>' +
          (m.sector ? ' ' + esc(m.sector) : '') +
          (m.reason === 'no_data' ? '（无数据）' : '');
      }).join('<span aria-hidden="true"> · </span>') + '</p>' : '';
      return row('gate', gate, missLine, '排行榜质量因子+SEC 缓存');
    };
    const market = action.market || {};
    const marketLine = market.state_text
      ? '<p class="action-market">市场背景：<b>' + esc(market.state_text) +
        (market.score == null ? '' : '（' + esc(market.score) + '分）') + '</b> · ' +
        esc(market.note || '只描述当前环境，不改变买卖规则。') + '<span class="action-source">来源：5 个市场状态信号</span></p>' : '';
    const reviewExtra = tickers(action.review.items, true) +
      (action.review.hold_count ? '<p class="action-hold">另有 ' + esc(action.review.hold_count) + ' 只按纪律持有。</p>' : '');
    return '<section class="card action-center" id="v32-actions-card">' +
      '<div class="block-title">今天怎么做</div>' +
      '<div class="action-list">' +
      row('buy', action.buy, tickers(action.buy.items, false), '当天研究结论') +
      gateRow(action.gate) +
      row('review', action.review, reviewExtra, '入选价与最新价格') +
      row('sell', action.sell, tickers(action.sell.items, true), '入选日期与锁仓纪律') +
      '</div>' + marketLine +
      '<p class="simple-muted action-note">' + esc(action.note || '系统不会自动交易。') + '</p></section>';
  }

  // v3.2 方向卡 + 持仓风险卡的占位骨架(真实数据由 loadV32Cards 异步填)。
  function v32CardsHTML() {
    return '<div id="v32-cards">' +
      '<section class="card action-center" id="v32-actions-card"><div class="block-title">今天怎么做</div>' +
      '<p class="sec-body">加载中…</p></section>' +
      '<section class="card regime" id="v32-regime-card"><div class="block-title">市场方向</div>' +
      '<p class="sec-body">加载中…</p></section>' +
      '<section class="card posrisk" id="v32-risk-card"><div class="block-title">持仓风险</div>' +
      '<p class="sec-body">加载中…</p></section></div>';
  }

  // v3.2 分层验证卡（纯函数）：买入组 vs 观察组，各自跑赢大盘的比例与平均超额。
  // 数据来自 /api/accuracy（唯一真源是 tools/accuracy-report.js，前端不重算，避免两边口径漂移）。
  function v32AccuracyHTML(acc) {
    if (!acc || !acc.byKind || typeof acc.byKind !== 'object') return '';
    const kindWord = function (k) {
      return k === 'pick' ? '买入组' : k === 'watch' ? '观察组' : String(k);
    };
    const rate = function (v) { return v == null ? '—' : v + '%'; };
    const delta = function (v) {
      if (v == null) return '—';
      return (v >= 0 ? '+' : '') + v + '%';
    };
    const order = ['pick', 'watch'];
    const keys = order.filter(function (k) { return acc.byKind[k]; })
      .concat(Object.keys(acc.byKind).filter(function (k) { return order.indexOf(k) < 0; }));
    const rows = keys.map(function (k) {
      const g = acc.byKind[k] || {};
      return '<li><b>' + esc(kindWord(k)) + '</b><span> ' + esc(g.n == null ? '—' : g.n) + ' 笔 · 跑赢大盘 ' +
        esc(rate(g.alphaPositiveRate)) + ' · 平均比大盘 ' + esc(delta(g.avgAlphaPct)) + '</span></li>';
    }).join('');
    const o = acc.overall || {};
    // 诚实线:买入组若没到 50%,直接写出来,不挑好看的展示
    const honest = (acc.byKind.pick && acc.byKind.pick.alphaPositiveRate != null
      && acc.byKind.pick.alphaPositiveRate < 50)
      ? '<p class="simple-muted">注意：买入组目前跑赢大盘的比例低于一半——本页不因此修改结论口径，只是如实记录。</p>'
      : '';
    return '<section class="card v32-acc"><div class="block-title">分层验证</div>' +
      '<ul class="mtd-factors">' + rows + '</ul>' +
      '<p class="sec-body">合计 ' + esc(o.n == null ? '—' : o.n) + ' 笔，整体跑赢大盘 ' +
        esc(rate(o.alphaPositiveRate)) + '，平均比大盘 ' + esc(delta(o.avgAlphaPct)) + '。</p>' +
      honest +
      '<p class="simple-muted">' + esc(acc.note || '描述性统计，不是预测证据。') + '</p></section>';
  }

  // v3.2 方向卡（纯函数）。regime 为 null/undefined 时显示数据不足。
  function regimeCardHTML(regime) {
    if (!regime || typeof regime !== 'object' || !regime.state) {
      return '<section class="card regime" id="v32-regime-card"><div class="block-title">市场方向</div>' +
        '<p class="sec-body">方向数据暂缺（行情或排行榜未就绪），按常态纪律办事。</p></section>';
    }
    const cls = regime.state === 'risk-on' ? ' regime--on'
      : regime.state === 'risk-off' ? ' regime--off' : ' regime--neutral';
    const sigs = Array.isArray(regime.signals) ? regime.signals.map(function (g) {
      const lv = g.level == null ? '' : g.level >= 100 ? '好' : g.level >= 50 ? '中' : '差';
      return '<li><b>' + esc(g.label) + '</b><span>' + esc(g.display) +
        (lv ? '（' + lv + '）' : '') + '</span></li>';
    }).join('') : '';
    return '<section class="card regime' + cls + '" id="v32-regime-card"><div class="block-title">市场方向 · ' +
      esc(regime.state_text || regime.state) +
      (regime.score == null ? '' : '（' + regime.score + '分）') + '</div>' +
      '<p class="sec-body">' + esc(regime.stance_text || '') + '</p>' +
      '<ul class="mtd-factors">' + sigs + '</ul>' +
      '<div id="v32-fwd"></div>' +
      '<p class="simple-muted">现状刻画，不是涨跌预测；阈值 v1 已冻结，前向追踪中，不构成投资建议。</p></section>';
  }

  // v3.2 前向对照(纯函数):方向账本攒够样本后,看当时的状态之后市场怎么走。
  // 样本不足就只报条数——后端不给平均值,前端也不会自己算。
  function forwardTableHTML(fwd) {
    if (!fwd || !fwd.byHorizon) return '';
    const horizons = Array.isArray(fwd.horizons) ? fwd.horizons : [];
    const rowsWithAvg = horizons.filter(function (h) {
      const b = (fwd.byHorizon[h] || {}).buckets || {};
      return Object.keys(b).some(function (k) { return b[k] && b[k].enough; });
    });
    if (!rowsWithAvg.length) {
      const need = Math.max(0, (horizons[0] || 5) + 1);
      return '<p class="fwd-line">前向对照：还在攒样本（现有 ' + esc(fwd.rows_with_spx || 0) +
        ' 条带点位记录，至少要 ' + esc(need) + ' 条才能对照第一个窗口）。' +
        '先记着，不改口径。</p>';
    }
    const states = ['risk-on', 'neutral', 'risk-off'];
    const head = '<tr><th>当时状态</th>' + horizons.map(function (h) {
      return '<th>' + esc(h) + ' 行后</th>';
    }).join('') + '</tr>';
    const body = states.map(function (st) {
      const cells = horizons.map(function (h) {
        const b = ((fwd.byHorizon[h] || {}).buckets || {})[st];
        if (!b || !b.n) return '<td>—</td>';
        if (!b.enough) return '<td>样本少（' + esc(b.n) + '）</td>';
        const v = b.avgPct;
        return '<td>' + esc((v >= 0 ? '+' : '') + v + '%') + '<span class="fwd-n">(' + esc(b.n) + ')</span></td>';
      }).join('');
      const label = ((fwd.byHorizon[horizons[0]] || {}).buckets || {})[st];
      return '<tr><td>' + esc((label && label.state_text) || st) + '</td>' + cells + '</tr>';
    }).join('');
    return '<div class="fwd-wrap"><p class="fwd-title">前向对照：当时的状态，之后指数实际怎么走</p>' +
      '<table class="fwd-table">' + head + body + '</table>' +
      '<p class="fwd-line">只统计、不预测；窗口按账本行数（≈交易日）推进。样本不够的格子不给平均值。</p></div>';
  }

  // v3.2:入选当天的论点快照(只读)。复核时读的是原文,不是被后来结论改写的版本。
  // 快照缺失就整块不显示——不回填、不编理由。
  function whyBoughtHTML(h) {
    const s = h && h.entry_snapshot;
    const hasContent = !!(s && (s.thesis || s.entry_evidence || s.skeptic_notes
      || (s.risks && s.risks.length) || (s.sources && s.sources.some(function (x) { return x && x.url; }))));
    if (!hasContent) return ''; // 只有日期/价格没有内容时不开空框
    const parts = [];
    if (s.thesis) parts.push('<p class="why-body">' + esc(s.thesis) + '</p>');
    const facts = [];
    if (s.captured_on) facts.push('入选 ' + esc(s.captured_on));
    if (s.price_at_entry != null) facts.push('入选价 ' + esc(s.price_at_entry));
    if (s.entry_evidence) facts.push('入选依据:' + esc(s.entry_evidence));
    if (facts.length) parts.push('<p class="why-facts">' + facts.join(' · ') + '</p>');
    if (s.risks && s.risks.length) {
      parts.push('<p class="why-sub">当时已知的风险</p><ul class="why-risks">' +
        s.risks.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') +
        (s.risks_total > s.risks.length ? '<li class="simple-muted">另有 ' + esc(s.risks_total - s.risks.length) + ' 条风险，见当日分析原文</li>' : '') +
        '</ul>');
    }
    if (s.skeptic_notes) parts.push('<p class="why-sub">当时写下的反方意见</p><p class="why-body">' + esc(s.skeptic_notes) + '</p>');
    if (s.sources && s.sources.length) {
      const links = s.sources.filter(function (x) { return x && x.url; }).map(function (x) {
        return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title || x.url) + '</a>';
      }).join(' · ');
      if (links) parts.push('<p class="why-src">来源:' + links + (s.sources_total > s.sources.length ? ' 等 ' + esc(s.sources_total) + ' 条' : '') + '</p>');
    }
    return '<details class="why-bought"><summary>当时为什么买</summary>' + parts.join('') + '</details>';
  }

  // 卖出侧的时间信息:锁仓到哪天、还差多少天。纪律是「持有满 365 天再复核」,
  // 不写出来用户就不知道什么时候才是合规的复核/调整时点。
  // 推不出日期时整行不显示——不猜、不写「大概」。
  function lockLineHTML(h) {
    const until = h && h.locked_until;
    const days = h && h.days_to_unlock;
    const pinged = h && h.unlock_alerted_on
      ? ' <i class="posrisk-badge">已提醒 ' + esc(h.unlock_alerted_on) + '</i>' : '';
    if (!until && days == null) return '';
    if (days == null) return '<p class="lock-line">锁仓至 ' + esc(until) + '</p>';
    if (days > 0) return '<p class="lock-line">锁仓至 ' + esc(until || '—') + '（还剩 ' + esc(days) + ' 天）</p>';
    if (days === 0) return '<p class="lock-line lock-line--done">锁仓期今天到期，可按纪律重新评估' + pinged + '</p>';
    return '<p class="lock-line lock-line--done">锁仓期已满（' + esc(until || '') + '），可按纪律重新评估' + pinged + '</p>';
  }

  // v3.7 论点复核包卡（纯函数）:入选原文复用 whyBoughtHTML,锁仓行复用 lockLineHTML,
  // “现在”区只摆最新财年硬数字与价格位置,不下判断;清单四问与后端 CHECKLIST 一致。
  function reviewPackHTML(pack) {
    if (!pack || typeof pack !== 'object' || pack.error || !pack.ticker) {
      return '<p class="sec-body">复核包暂缺（该持仓不在名单里）。</p>';
    }
    const parts = [];
    const price = pack.price || {};
    const drift = price.drift_pct == null ? '—' : (price.drift_pct >= 0 ? '+' : '') + price.drift_pct + '%';
    parts.push('<p class="why-facts">入选价 ' + esc(price.entry_price == null ? '—' : price.entry_price) +
      ' · 现价 ' + esc(price.last_price == null ? '—' : price.last_price) +
      ' · 浮动 ' + esc(drift) + '</p>');
    parts.push(whyBoughtHTML({ entry_snapshot: pack.entry }));
    const now = pack.now || {};
    const nowLine = now.latest_fy == null ? '最新财年硬数据暂缺。'
      : '最新 FY' + esc(now.latest_fy) + '：营收 ' + esc(now.revenue_yi == null ? '—' : now.revenue_yi + '亿') +
      ' · 净利 ' + esc(now.net_income_yi == null ? '—' : now.net_income_yi + '亿') +
      ' · 自由现金流 ' + esc(now.fcf_yi == null ? '—' : now.fcf_yi + '亿') +
      (now.net_margin_pct == null ? '' : ' · 净利率 ' + esc(now.net_margin_pct) + '%');
    parts.push('<p class="why-sub">现在（SEC 最新财年，不下判断）</p><p class="why-body">' + esc(nowLine) + '</p>');
    parts.push(lockLineHTML({ locked_until: (pack.lock || {}).locked_until, days_to_unlock: (pack.lock || {}).days_to_unlock }));
    const list = Array.isArray(pack.checklist) ? pack.checklist : [];
    if (list.length) {
      parts.push('<p class="why-sub">复核四问（固定清单，每只持仓相同）</p><ol class="why-risks">' +
        list.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>');
    }
    parts.push('<p class="simple-muted">' + esc(pack.note || '只摆事实，不下买卖结论。') + '</p>');
    return parts.join('');
  }

  // v3.2 持仓风险卡（纯函数）。risk 为 null 时显示缺失态。
  function positionRiskCardHTML(risk) {
    if (!risk || !Array.isArray(risk.holdings) || !risk.holdings.length) {
      return '<section class="card posrisk" id="v32-risk-card"><div class="block-title">持仓风险</div>' +
        '<p class="sec-body">名单暂无持仓，或风险数据未就绪。</p></section>';
    }
    const tierWord = function (t) {
      return t === 'alert' ? '重点复核' : t === 'watch' ? '复核' : t === 'unknown' ? '数据缺失' : '持有';
    };
    const stripLead = function (tier, action) {
      const w = tierWord(tier);
      const a = String(action || '');
      return (a.indexOf(w) === 0) ? a.slice(w.length).replace(/^[：:]\s*/, '') : a;
    };
    const items = risk.holdings.map(function (h) {
      const drift = h.drift_pct == null ? '—' : (h.drift_pct >= 0 ? '+' : '') + h.drift_pct + '%';
      const badge = h.alerted_on
        ? ' <i class="posrisk-badge">已提醒 ' + esc(h.alerted_on) + '</i>' : '';
      return '<li><b>' + esc(h.ticker) + '</b><span> ' + esc(drift) + ' · ' +
        esc(tierWord(h.tier)) + badge + '：' + esc(stripLead(h.tier, h.action)) + '</span>' +
        lockLineHTML(h) + whyBoughtHTML(h) +
        '<details class="review-pack" data-ticker="' + esc(h.ticker || '') + '">' +
        '<summary>复核清单</summary><p class="sec-body">展开后加载…</p></details></li>';
    }).join('');
    return '<section class="card posrisk" id="v32-risk-card"><div class="block-title">持仓风险</div>' +
      '<ul class="mtd-factors">' + items + '</ul>' +
      '<p class="simple-muted">分级只决定复核优先级，不自动卖出；365天锁仓纪律不变。</p></section>';
  }

  function methodHTML() {
    return simpleMethodHTML() + v32MethodHTML();
    // ⚠️ 全页第一块,不可下移、不可折叠。对应 RUBRIC v2.4 §0「否定性结论」。
    // 铁律:两句话必须同时出现——「没有证据说能跑赢大盘」+「也不等于已证明没用」。
    // 只写其中一句都是把话说过头(功效不足时两个方向都不能断言)。
    const evidence =
      '<section class="card mtd-evidence">' +
      '<div class="block-title">先说最重要的一件事</div>' +
      '<p class="mtd-headline">我们<b>没有证据</b>表明这个分数能帮你跑赢大盘。</p>' +
      '<p class="sec-body">「大盘」指标普 500 —— 美国最有代表性的 500 家公司打包成的一个指数,' +
      '任何人都能花几分钟买到(比如 SPY 这类基金)。它是你不用这个 App 时最省事的替代方案,' +
      '所以我们拿它当及格线:<b>选股要有意义,就得比它多赚。</b></p>' +

      '<div class="mtd-sub">我们把这套打分法拿过去约 12 年的真实行情从头测了一遍,结果是:</div>' +
      '<ul class="mtd-factors mtd-neg">' +
      '<li><b>分高分低,后来的表现几乎没差别。</b>按分数从低到高分成五组,往后一年跑赢大盘的比例分别是 ' +
        '42.5%、43.9%、44.7%、43.0%、44.6% —— 分最高的那组不是最好的,中间那组反而最好,' +
        '而且<b>五组没有一组超过 45%</b>。</li>' +
      '<li><b>按我们自己的榜单买前 20 名,往后一年跑赢大盘的比例是 43%。</b>' +
        '也就是说,剩下约 57% 的时间是跑输的。</li>' +
      '<li><b>照公开投资研究文献搭了 24 套打分法一起测,通过检验的是 0 套。</b>' +
        '检验有三道:换个没用过的时间段还管不管用、把「试了很多套自然会撞上几套」这件事扣掉之后还剩多少、' +
        '再按学术界观察到的「方法公开后效果普遍打折」打完折还剩多少。' +
        '这 24 套里<b>也包含我们自己正在用的这套</b>,它同样没通过。</li>' +
      '<li><b>把手续费算进去会更差。</b>按每笔 0.25% 的交易成本、每月调仓算,' +
        '这套打分法过去 12 年每年比直接买大盘<b>少赚约 7 个百分点</b>;只用「跌得多」这一个因子的版本少赚约 10 个。</li>' +
      '<li><b>过去我们的及格线画低了。</b>以前是拿「这批股票自己的平均表现」当参照,' +
        '可那条线本身每年就比大盘低 1.3–2.1 个百分点 —— 赢了它并不等于赢了大盘。' +
        '现在一律改成跟大盘(含分红)比。</li>' +
      // RUBRIC v2.5 §0.10:结论范围已从「本项目这套评分」扩到「我们能想到的全部办法」。
      '<li><b>后来我们把能想到的办法全试了一遍:8,966 种,一种都没通过。</b>' +
        '分成八个方向找——只看股价的、只看财报的、把各种指标拼起来的、赌短期反弹的、' +
        '判断什么时候该空仓的、找季节和日历规律的、横着比 500 只的、盯财报公布这类事件的。' +
        '全部按同一套事先写死的规则判定,<b>幸存者 0 个</b>。</li>' +
      // RUBRIC v2.5 §0.13:不得再说「我们从五个角度看它是不是便宜」。
      '<li><b>我们那个「便宜分」看着是五个角度,其实是同一件事量了五遍。</b>' +
        '实测这五项彼此的相关度高达 0.85–0.94,说的都是「现在比它自己过去两年便宜多少」。' +
        '所以权重怎么调都基本不改变排序。(好消息是:「公司质量分」和它的相关度只有 0.02–0.10,' +
        '确实是另一件独立的事。)</li>' +
      '</ul>' +

      '<div class="mtd-sub">但请不要走到另一个极端:这<b>不等于</b>「已经证明它没用」。</div>' +
      '<ul class="mtd-factors">' +
      // 只报难看的数字也是一种不诚实。RUBRIC v2.4 §0.3 要求反向证据一并写出。
      '<li><b>说句公道话:换个比法,它其实略占上风。</b>如果拿「500 家公司每家买一样多」这种平均分配的组合当参照,' +
        '我们这套打分往后一年跑赢它的比例约 59%–63%。但那不是你会去买的东西——' +
        '你能一键买到的是标普 500 本身,里面<b>大公司占的份额更大</b>。对着它我们就没有优势了。' +
        '这个差别更像是「我们的打分偏爱中小公司」这类<b>风格差异</b>,而过去 12 年恰好是大公司领涨;' +
        '风向变了结论也可能反过来。而且这一条同样<b>没到能下定论的程度</b>。</li>' +
      '<li>我们手上只有约 12 年数据。这么点数据,统计上<b>只能查出「每年多赚 10 个百分点以上」这种大效果</b>。</li>' +
      '<li>而现实里一个好的选股方法,通常也就每年多赚 1–3 个百分点。' +
        '要可靠地量出「每年多赚 3 个百分点」,需要约 <b>114 年</b>的数据;量出 5 个百分点也要 43 年。' +
        '<b>这个大小我们根本量不出来</b> —— 量不出来,和「等于零」,是两回事。</li>' +
      // RUBRIC v2.5 §0.11:检出下限 7.03%/年。「零幸存」只能读成「没有 ≥7%/年 的东西」,
      // 不得读成「市场上没有规律」——这条是明令。
      '<li><b>「8,966 种全军覆没」到底能读出什么?</b>只能读成:' +
        '<b>没有一种大到每年多赚 7% 以上、且能被这份数据证明的办法</b>。' +
        '现实中好的选股方法通常每年多赚 1–3%,这个大小我们这点数据根本分辨不出来。' +
        '所以它<b>不等于</b>「市场上没有规律」,更不等于「一切都是随机的」。</li>' +
      '<li>所以准确的说法只有一句:<b>没有证据说它行,也没有证据说它不行。</b>' +
        '谁要是跟你讲得比这更肯定,那句话就超出了数据能支撑的范围。</li>' +
      '</ul>' +

      '<details class="mtd-more"><summary>我们还查了「自己用的统计方法本身准不准」</summary>' +
      '<p class="sec-body">做法:造一批<b>明知道完全没用</b>的假数据,再用各种常见统计方法去测,' +
      '看它们多久会误报一次「有效」。正常应该是 20 次里错 1 次(5%)。实测结果:' +
      '最常见的那种逐条去测的做法会在 <b>50.5%</b> 的情况下误报,另外几种业界常用的校正方法也有 8.5%–25% 的误报率;' +
      '只有一种叫 Westfall-Young 的方法误报率正常(5.0%)。' +
      '换成这个准确的方法重新检查我们那 92 套权重组合,结果是<b>一套都没通过</b>。' +
      '这也说明:在这类数据里看到一个「看起来很显著」的结果,先默认它是噪声更安全。</p></details>' +

      '<div class="mtd-sub">那这个分数还有什么用?</div>' +
      '<ul class="mtd-factors">' +
      '<li><b>它是排队号码,不是买卖信号。</b>500 只股票不可能每天都让 AI 深入研究一遍,' +
        '分数决定今天先研究哪几只。</li>' +
      '<li><b>真正有价值的是研究记录本身</b>:每条 AI 结论都附了它查过的资料和原始链接,' +
        '你可以点进去自己核对,再自己下判断。</li>' +
      '<li><b>请把这里当成一份读物,而不是一个买卖指令。</b>要不要买、买多少,只能你自己决定。</li>' +
      '</ul>' +
      '<p class="mtd-foot">上面每个数字都来自可重跑的历史检验;检验用的是「当年真的在标普 500 里」的股票名单,' +
      '不是拿今天的名单倒推(那样会自动跳过后来退市、被收购的公司,把成绩算得比实际好看)。' +
      '完整算法与可以照着重跑一遍的命令,写在 RUBRIC.md 的 §0。</p>' +
      '</section>';

    const lead =
      '<section class="card mtd-lead">' +
      '<p class="sec-body">每只股票先看<b>方向</b>:↑ 值得关注、↓ 建议回避、→ 继续等待、◇ 还在排队。' +
      '再看 <b>1–100 的「买入理由完整度」</b>:分高表示「现在买、并且拿 3 年以上」这个理由被查证得比较完整;' +
      '分低表示<b>现在不适合买</b>,但<b>不等于它以后会跌</b>——只有那个专门挑毛病的 AI 找到伤及长期前景的硬证据、' +
      '并且明确否决，才会被标成建议回避。' +
      '这个分衡量的只有一件事:<b>「买它并长期拿着」这个说法被核实到了什么程度</b>，' +
      '<b>不是涨跌概率、不是历史胜率、不是预计能涨多少，也不是跑赢大盘的可能性</b>（原因见本页开头）。' +
      '用旧办法打过分的老结论会直接写成「旧版评分 N/10 · 待重算」，不会伪装成新的 1–100 分；' +
      'AI 还没研究过的只显示电脑估分。</p>' +
      '</section>';

    const bands =
      '<section class="card">' +
      '<div class="block-title">先看结果:三种颜色什么意思</div>' +
      methodBandRow('dot-good', '值得关注', '60 分以上',
        'AI 做过最细的研究,确认公司本身过硬、现在股价又在低处。所有达标的都会留在名单上，首页只突出理由查得最完整的 3 只。' +
        '这一档只表示「研究做到位了」,不表示它会涨、也不表示它会跑赢大盘——见本页开头。') +
      methodBandRow('dot-warn', '继续等待', '40–59 分',
        '看着便宜、或者公司还不错,但还没经过最严格的核实。先看着,别急着买。') +
      methodBandRow('dot-crit', '不建议买', '40 分以下',
        '要么 AI 研究后否决了,要么又贵又平庸。') +
      '</section>';

    const steps =
      '<section class="card">' +
      '<div class="block-title">分数怎么来的:三步走</div>' +
      methodStep('1', '第一步 · 现在跌得够不够便宜(电脑算,每天全部约 500 只都算)',
        // 注意:methodStep 的 lead/factors/foot 都会被 esc,这里不能写 HTML 标签。
        '只看股价走势,不管公司好坏。回答一个问题:跟它自己的历史比,现在算不算便宜。' +
        // RUBRIC v2.5 §0.13 明令:不得再说「我们从五个角度看」。
        '下面列了五项,但必须说清楚:实测发现这五项其实是同一件事的五种写法(彼此相关 0.85–0.94),' +
        '合起来也只回答这一个问题,不是五个独立的角度。',
        [
          ['跟过去 2 年比现在的价位', '越靠近这两年的低点分越高(这条最重要)'],
          ['离一年内最高点跌了多少', '跌得越多越便宜,但设了上限,防止「接飞刀」'],
          ['最近有没有开始止跌（2026-07-30 已停用）', '这一项算的其实是「最近已经涨了多少」，'
            + '给它加分等于奖励已经反弹的股票，结果就是等股票涨上来了才推荐给你。已经把它的权重降到 0。'],
          ['是不是跌破了长期均线(200 天)', '跌破说明确实在低位'],
          ['波动太剧烈会扣分', '跌得又急又猛的,反而扣分——不稳'],
        ],
        '这一步只回答「相对它自己够不够便宜」,完全不看公司质量。') +
      methodStep('2', '第二步 · 公司本身好不好(电脑读官方财报算)',
        '便宜不等于好。有的股票跌得多是「活该跌」——生意本身在垮。这一步就是把这类排除掉。',
        [
          ['生意在不在长大', '看营收这几年增长快不快'],
          ['赚不赚钱', '看利润率高不高、是变好还是变差'],
          ['有没有真金白银进账', '看「自由现金流利润率」——每 100 块营收里,扣掉开销和设备投入后真正剩下多少现金。剩得越多分越高'],
          ['欠债多不多', '负债越轻越稳；净资产为负会明确记低分，不再当成数据缺失'],
        ],
        '公司太新、财报不足 3 年的,这步就留空、不硬猜。'
        + '2026-07-29 修正了「有没有真金白银进账」这一项:原来只数「现金流为正的年头有几个」,'
        + '结果 500 家里有 8 成多都拿满分、根本分不出高低,谁进前 20 名实际上是按名单顺序碰运气决定的。'
        + '现在改成看真实的现金流利润率。') +
      methodStep('3', '第三步 · AI 深入研究(每场 12 只、每天 3 场,轮着把 500 只全覆盖一遍)',
        '让最强的 AI 花时间去读新闻、财报和唱空的观点,再由另一个专门「挑毛病的 AI」试着推翻它。' +
        '只有闯过这一关的股票,才可能被标成「值得关注」。前两步电脑算出来的分,最高只能到 59,进不了绿色那一档。' +
        '每天能被深入研究的名额有限,优先给最大的 200 家公司——先把大家最常持有的大公司核实一遍,再轮到别的。',
        null,
        '这是唯一能产生「值得关注」的通道。AI 必须给出完整的 1–100 分和「现在算不算低」的判断；' +
        '前后说法打架就自动重来一次。用旧办法打过分、又带买卖方向的股票排在最前面重算，' +
        '之后每场也会留名额给旧分重算和从没研究过的新股票。') +
      methodStep('＋', '每天:全部 500 只先由固定算法过一遍(这一步不花 AI 额度)',
        '每天三场,电脑都会把全部 500 只的股价、股价位置分、公司质量分重新算一遍并重新排序——纯算法,不花 AI 额度。' +
        '谁该被送去让 AI 深入研究,就按这个排序定;哪只股价突然涨跌超过 10%,旧结论立刻作废、自动插到最前面重新研究。',
        null,
        '第一轮筛选交给算法、AI 只研究入围的少数——省下来的额度全部留给真正重要的深入研究。' +
        '以前那个「用便宜 AI 每天把 500 只快速扫一遍」的做法已经改成手动工具,需要时才跑。') +
      methodStep('↻', 'AI 没运行的日子(额度用完或出故障):只有电脑算的部分会更新',
        '如果 AI 遇到额度或网络问题,系统会立刻停手、不做无意义的重试,但仍然会刷新全部股票的股价、' +
        '股价位置分、公司质量分和总排名。',
        null,
        '这种日子有两条硬规则:①首页顶部直接写「今天 AI 未运行,没有新的买入结论」,' +
        '并说明这不代表今天没有值得买的股票——系统没跑成不是投资结论;' +
        '②这一场不给你发手机通知,免得你把「没跑成」当成「今天没机会」。' +
        '页面上带方向的那些行,都是以前 AI 研究出来的结论,每条都标着是哪天做的,' +
        '只在 21 天有效期内、且股价没有大幅变动时才继续显示。') +
      '</section>';

    const tbl =
      '<section class="card">' +
      '<div class="block-title">四种处境,分数怎么定</div>' +
      '<table class="mtd-table"><tbody>' +
      '<tr><td>AI 还没深入研究过</td><td>把「股价位置分 + 公司质量分」等合成一个分,再打 6 折</td><td class="mtd-cap">最高 59</td></tr>' +
      '<tr><td>研究过、但没达到买入标准</td><td>电脑估分和买入理由完整度取高的那个，方向仍然是「继续等待」</td><td class="mtd-cap">最高 59</td></tr>' +
      '<tr><td>挑毛病的 AI 明确否决</td><td>只看买入理由完整度，不给电脑估分兜底；方向标成「建议回避」</td><td class="mtd-cap">最高 39</td></tr>' +
      '<tr><td>研究后确认可以买</td><td>直接用 1–100 的买入理由完整度</td><td class="mtd-cap mtd-cap--buy">60–100</td></tr>' +
      '</tbody></table>' +
      '<p class="mtd-foot">一句话:没经过对应级别的核实,分数就上不去。只被电脑算过、或只被便宜的 AI 快速扫过一遍的,再好也到不了 60。</p>' +
      '<details class="mtd-more"><summary>想细看:合起来的那个分和「打 6 折」是怎么回事</summary>' +
      '<p class="sec-body">电脑估分 = 股价位置分 × 45% ＋ 公司质量分 × 45% ＋ 便宜程度分 × 10%;' +
      '（「便宜程度分」= 拿公司一年赚的钱去比它现在的市值，比出来越划算分越高。）' +
      '缺哪一项,就把剩下的比例重新分一下。算完再 ×0.6(打 6 折),' +
      '是因为这类股票还没经过 AI 核实,不该占到「值得关注」的位置。</p></details>' +
      '</section>';

    const gate =
      '<section class="card">' +
      '<div class="block-title">要被标成「值得关注」,必须同时满足</div>' +
      '<ul class="mtd-factors">' +
      '<li>AI 深入研究后,买入理由完整度 ≥ 60/100(AI 自评和「挑毛病的 AI」两个分,取低的那个)</li>' +
      '<li>必须是按现在这套 100 分标准做的完整研究；用旧办法打的 N/10 一律先等着重算</li>' +
      '<li>没被「挑毛病的 AI」一票否决</li>' +
      '<li>确认现在的股价确实在低处</li>' +
      '<li>达标的都会留在名单上；首页和手机通知只突出理由查得最完整的 3 只</li>' +
      '</ul>' +
      '<p class="mtd-foot">那个「挑毛病的 AI」直接在 100 分制上扣分:真实但只影响短期的问题一般扣 10–20 分,' +
      '还没发生、只是听着吓人的风险一般扣 5–10 分;只有拿得出实锤、且真的伤到三五年前景的,' +
      '才会被压到 39 分以下并标成「建议回避」——而且必须附上可以点开核对的来源。' +
      '被压到「继续等待」之后,摘要会改成显示反对意见,不会还挂着「可以买」的旧说法。' +
      '榜单固定分成值得关注、建议回避、继续等待、还在排队四组,方向相反的两组不会拿分数硬比谁更好。</p>' +
      '<p class="mtd-foot">股价和电脑算的分数每天三场全部刷新;一条 AI 研究结论最多用 21 天(到期重新研究),' +
      '这期间股价涨跌超过 10% 就提前作废、立刻排队重研究——价格一出事就重新看,平时不浪费额度反复研究。</p>' +
      '</section>';

    // 2026-07-28 起对外必须交代清楚的三件事:结论出自哪个 AI、旧结论怎么处理、成绩单为什么不给胜率
    const honesty =
      '<section class="card">' +
      '<div class="block-title">我们不会瞒着你的三件事</div>' +
      '<ul class="mtd-factors">' +
      '<li><b>结论是哪个 AI 得出的</b>——当前主力是 Codex/GPT；历史 Claude 结论与 Codex/GPT 结论分开标记。' +
        'GPT 得出的结论照常入榜，但会标上「GPT 复核中」，两家的准确率也分开统计。</li>' +
      '<li><b>旧结论不会冒充新结论</b>——以前被判成「可以买入 / 应当回避」、但那个判断已经不符合现在标准的股票，' +
        '会单独列进首页的「待复核」块，明确写着「不作为今天的建议」。没有新证据就不推荐，这条不放宽。</li>' +
      '<li><b>成绩单不显示「胜率」</b>——记录太少、同一家公司被重复记多次，而且过去那个「胜率」把「股价涨了」' +
        '就算赢；行情整体上涨时随便买什么都会「赢」，这个数说明不了本事。攒够样本前只报进度，' +
        '之后报的是「比标普 500（美股大盘指数）多赚还是少赚」。</li>' +
      '</ul>' +
      '</section>';

    const foot =
      '<p class="mtd-version">历史评分说明 v2.8 · 数据还太少，没法把分数校准成概率，' +
      '所以这里只给「买入理由完整度」，不给「成功概率」，也不给任何「跑赢大盘的可能性」。' +
      '这一页写的和代码里跑的是同一套算法。AI 生成,仅供参考,不构成投资建议。</p>';

    // 「怎么拿」排在讲完分数之后:先让用户知道这个分数有多大能耐,再告诉他
    // 真正能改善结果的事其实不在分数里(第 13 轮结论,RUBRIC §0.18)。
    const structure = holdingStructureHTML();

    // evidence 必须排在最前:用户在读懂「分数怎么算」之前,先知道「这个分数没被证明有预测力」。
    // glossaryListHTML 放最后:整页读下来还有不懂的词,就在这儿点开查。
    return evidence + lead + bands + steps + tbl + gate + honesty + structure + glossaryListHTML() + foot;
  }

  /* ==================== 怎么拿,比挑哪只更重要 ====================
     2026-07-31,第 13 轮实验之后新增。前 13 轮(12 轮选股 + 1 轮跨市场跟趋势)全部没找到
     能预测涨跌的东西;但同一批数据算出来,下面这三件事每年合计能多留 3%–5%,
     比任何一个分数的作用都大一个数量级,而且一件都不需要预测。
     数字来源:本仓库 S&P 500 时点名单 2007-02~2026-04 实测(每种持股只数各抽样 500 次),
     以及逐笔税务模拟。学术对照见 RUBRIC §0.18。 */
  const HOLD_TABLE = [
    { n: '只买 1 只', win: '38.8%' },
    { n: '买 3 只', win: '41.5%' },
    { n: '买 20 只', win: '44.0%' },
    { n: '买 50 只', win: '43.9%' }
  ];

  function holdingStructureHTML() {
    const rows = HOLD_TABLE.map(function (r) {
      return '<tr><td>' + esc(r.n) + '</td><td class="mtd-cap">' + esc(r.win) + '</td></tr>';
    }).join('');
    return '<section class="card">' +
      '<div class="block-title">怎么拿,比挑哪只更重要</div>' +
      '<p class="mtd-foot">下面三件事都不用预测涨跌,加起来每年大约能多留 3%–5%,' +
      '比这个榜单上任何一个分数的作用都大得多。</p>' +
      '<ul class="mtd-factors">' +
      '<li><b>一、别只买两三只,分到 20–50 只,每只放差不多的钱,一年调一次让它们重新变回一样多。</b>' +
      '这不会让你赚得更多,但会让你更可能拿到「平均水平」——少数几只暴涨的股票把平均数拉得很高,' +
      '买得太少大概率抽不到它们。</li>' +
      '<li><b>二、少买卖,一只拿满三五年。</b>每卖一次都要交一次税、付一次手续费;' +
      '把换手降下来,一年大约多留 0.5%–1.2%。</li>' +
      '<li><b>三、能放进免税账户的就放进去</b>(在美国报税的人适用,比如 Roth IRA、401k)。' +
      '同样的股票、同样的买卖,只是不用每年交税,一年大约多留 2.2%–3.4%。这是算出来的,不是猜的。</li>' +
      '</ul>' +
      '<p class="mtd-foot">随便挑几只拿满十年,比标普 500 多赚的可能性:</p>' +
      '<table class="mtd-table"><tbody>' + rows + '</tbody></table>' +
      '<p class="mtd-foot">这张表最该看的不是「哪个数大」,而是<b>四个数都不到一半</b>。' +
      '随便挑股票拿十年,比大盘多赚的可能性本来就低于 50%,而且拿得越久越低——' +
      '这是数学,不是本事问题。分散不会把这个数变高多少,它只是让你少踩到最差的那种结果。</p>' +
      '<p class="mtd-foot">数字出处:用标普 500 历史成分名单 2007 年至今的真实行情算的(每种只数各随机抽 500 次组合),' +
      '外加一份逐笔的税费模拟。要提醒的是,十年这个跨度在这段历史里只装得下大约两个不重叠的十年,' +
      '所以这几个数看方向可以,别当成精确值。</p>' +
      '</section>';
  }

  function v3DecisionOfRow(row) {
    if (!row || row.confidence_source !== 'decision_v3') return null;
    const d = String(row.decision || '').toLowerCase();
    if (d === 'buy' || d === 'wait' || d === 'avoid') return d;
    if (row.call === 'buy') return 'buy';
    if (row.call === 'avoid') return 'avoid';
    if (row.call === 'watch') return 'wait';
    return null;
  }

  // 极简首页也必须让用户在不点开的情况下回答四个问题：看多久、方向是什么、
  // 眼下发生了什么、凭什么。过去 1 个月涨跌是历史事实；forecast.one_month
  // 才是未来约 1 个月的主观方向，两者必须分开写。
  function simpleEvidenceFactsHTML(row, full) {
    row = row || {};
    full = full || {};
    const md = (full.market_data && typeof full.market_data === 'object') ? full.market_data : {};
    const facts = [];
    const px = firstNum(md.price, row.price);
    const day = firstNum(md.changeDayPct, row.changeDayPct);
    const month = firstNum(md.change1mPct, row.ret1mPct, row.change1mPct);
    const drawdown = firstNum(md.drawdownFromHighPct, row.drawdownFromHighPct);
    const pctile = firstNum(row.pctileIn2y);
    if (isFinite(px)) facts.push('<span><b>现价</b>' + esc(money(px, 2)) + '</span>');
    if (isFinite(day)) facts.push('<span><b>当日</b>' + esc(signedPct(day)) + '</span>');
    if (isFinite(month)) facts.push('<span><b>过去 1 个月实际涨跌</b>' + esc(signedPct(month)) +
      '<small>历史，截至分析日</small></span>');
    if (isFinite(drawdown)) facts.push('<span><b>距 52 周高点</b>' + esc(signedPct(drawdown)) + '</span>');
    if (isFinite(pctile)) facts.push('<span><b>两年价格位置</b>' + esc(Number(pctile).toFixed(1)) + '%</span>');
    return facts.length ? '<div class="simple-facts">' + facts.join('') + '</div>' : '';
  }

  function simpleDirectionMeta(decision) {
    if (decision === 'buy') return { arrow: '↑', text: '偏多 · 值得关注' };
    if (decision === 'avoid') return { arrow: '↓', text: '前景转弱 · 建议回避' };
    return { arrow: '→', text: '方向未确认 · 继续等待' };
  }

  function simpleForecastOf(row, full, decision) {
    row = row || {};
    full = full || {};
    const raw = (full.forecast && typeof full.forecast === 'object')
      ? full.forecast : ((row.forecast && typeof row.forecast === 'object') ? row.forecast : null);
    const allowed = { up: 1, flat: 1, down: 1, uncertain: 1 };
    const cleanDirection = function (v, fallback) {
      const s = String(v == null ? '' : v).toLowerCase();
      return allowed[s] ? s : fallback;
    };
    const native = !!raw && raw.source === 'model_v4';
    const legacyLong = decision === 'buy' ? 'up' : decision === 'avoid' ? 'down' : 'uncertain';
    const confidenceRaw = raw && Number(raw.confidence);
    const compatibility = firstNum(full.confidence_level, row.confidence_level);
    const confidence = Number.isFinite(confidenceRaw) && confidenceRaw >= 1 && confidenceRaw <= 10
      ? Math.round(confidenceRaw * 10) / 10
      : (isFinite(compatibility) ? Math.round(Math.max(1, Math.min(100, compatibility))) / 10 : null);
    let recommended = raw && String(raw.recommended_horizon || '').toLowerCase();
    if (['short', 'medium', 'long', 'none'].indexOf(recommended) === -1) {
      recommended = decision === 'buy' ? 'long' : 'none';
    }
    return {
      oneMonth: raw ? cleanDirection(raw.one_month, 'uncertain') : 'uncertain',
      oneYear: raw ? cleanDirection(raw.one_year, 'uncertain') : 'unassessed',
      longTerm: raw ? cleanDirection(raw.long_term, legacyLong) : legacyLong,
      recommended: recommended,
      confidence: confidence,
      native: native,
    };
  }

  function simpleForecastLeadHTML(row, full, decision, horizon) {
    const f = simpleForecastOf(row, full, decision);
    const directionText = {
      up: '预计上涨', flat: '预计震荡', down: '预计下跌', uncertain: '方向不明', unassessed: '未单独评估'
    };
    const recommendedText = { short: '短期（1个月内）', medium: '中期（1年内）', long: '长期（3—5年）', none: '暂不推荐' };
    const confidence = f.confidence == null ? '暂无' : String(f.confidence).replace(/\.0$/, '') + '/10';
    const caveat = f.native
      ? '这是 AI 对证据把握程度的主观评分，不是上涨概率或历史命中率。'
      : '旧简报没有分别预测三个期限；1个月与1年如实标缺失，信心值按原结论档位换算。';
    return '<div class="simple-forecast-lead">' +
      '<span>一句话看未来</span>' +
      '<p><b>1个月 ' + esc(directionText[f.oneMonth]) + '</b>；' +
        '<b>1年 ' + esc(directionText[f.oneYear]) + '</b>；' +
        '<b>' + esc(horizon || '3—5年') + ' ' + esc(directionText[f.longTerm]) + '</b>。' +
        '推荐周期：<strong>' + esc(recommendedText[f.recommended]) + '</strong>。' +
        '信心：<strong>' + esc(confidence) + '</strong>。</p>' +
      '<small>' + esc(caveat) + '</small>' +
    '</div>';
  }

  function simpleHomeAnalysisMap(brief) {
    const out = Object.create(null);
    const roster = brief && Array.isArray(brief.roster) ? brief.roster : [];
    roster.forEach(function (item) {
      if (!item || item.analyzed !== 'deep' || !item.ticker) return;
      out[String(item.ticker).toUpperCase()] = item;
    });
    return out;
  }

  function simpleHomeHTML(brief, rows, opts) {
    const o = opts || {};
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const current = list.filter(function (r) { return r.deep && v3DecisionOfRow(r); });
    const order = { buy: 0, wait: 1, avoid: 2 };
    current.sort(function (a, b) {
      return order[v3DecisionOfRow(a)] - order[v3DecisionOfRow(b)]
        || String(a.ticker).localeCompare(String(b.ticker));
    });
    const buys = current.filter(function (r) { return v3DecisionOfRow(r) === 'buy'; });
    const legacy = list.filter(function (r) { return r.deep && r.confidence_source !== 'decision_v3'; }).length;
    const aiRan = o.aiRan === true;
    const headline = !aiRan ? '今天没有完成新的 AI 研究'
      : buys.length ? '今天有 ' + buys.length + ' 家通过两轮研究'
        : '今天没有公司通过两轮研究';
    const reason = !aiRan
      ? '系统没有跑成，不等于市场没有机会。行情和公开财报仍已更新。'
      : buys.length ? '每张卡先给时间范围、方向和关键数据，点开可核对完整分析与来源。'
        : '证据不够就等待，不为凑数给结论。';
    const label = { buy: '通过', wait: '等待', avoid: '回避' };
    const analysisByTicker = simpleHomeAnalysisMap(brief);
    const cards = current.slice(0, 3).map(function (r, idx) {
      const d = v3DecisionOfRow(r);
      const ticker = String(r.ticker == null ? '' : r.ticker).toUpperCase();
      const full = analysisByTicker[ticker] || null;
      const merged = full ? Object.assign({}, r, full) : r;
      const horizon = (full && full.horizon) || r.horizon_label || '3 年以上';
      const note = plainifyAiNote(r.ai_note || r.reason || '查看研究记录了解依据。');
      const sourceCount = full && Array.isArray(full.sources) ? full.sources.length : 0;
      const detail = full
        ? leaderboardRowBodyHTML(r, 'simple' + idx, full, null)
        : '<div class="analysis-loading" role="status"><span class="analysis-loading-dot"></span>' +
          '<span>点开后读取完整研究…</span></div>';
      return '<details class="simple-result simple-result--' + d + '" data-ticker="' + esc(ticker) + '"' +
        ' data-analysis-date="' + esc(r.analyzed_on || (brief && brief.date) || '') + '" data-ready="' + (full ? '1' : '0') + '">' +
        '<summary class="simple-result-summary">' +
          '<div class="simple-result-head"><div><b class="simple-ticker">' + esc(ticker) + '</b>' +
          '<span class="simple-name">' + esc(r.name || '') + '</span></div>' +
          '<span class="simple-decision">' + esc(label[d]) + '</span></div>' +
          simpleForecastLeadHTML(r, merged, d, horizon) +
          simpleEvidenceFactsHTML(r, merged) +
          '<p><b class="simple-reason-label">核心依据</b>' + esc(note) + '</p>' +
          '<span class="simple-open">查看完整分析' + (sourceCount ? '与 ' + sourceCount + ' 条来源' : '') +
            '<i aria-hidden="true">›</i></span>' +
        '</summary>' +
        '<div class="simple-detail">' + detail + '</div>' +
      '</details>';
    }).join('');
    const empty = cards ? '' : '<div class="simple-empty">' +
      (legacy ? legacy + ' 条旧结论正在按新规则复核，复核前不作为当前建议。'
        : '当前没有可展示的新结论。') + '</div>';
    return '<div class="simple-stack">' +
      '<section class="card simple-hero">' +
      '<span class="simple-kicker">今天结论</span><h2>' + esc(headline) + '</h2><p>' + esc(reason) + '</p>' +
      '<p class="simple-honesty">1个月、1年和3—5年都是带不确定性的主观方向判断；信心分不是上涨概率，也不编目标价。</p>' +
      (cards || empty) + '</section>' +
      v32CardsHTML() +
      '<section class="card simple-process">' +
      '<span class="simple-kicker">方法</span><h2>固定轮换 → 正反两轮 → 一年复核</h2>' +
      '<p>没有选股分数。只有两轮都通过、价格合理、财报资料足够，才进入最多 20 家的关注名单。</p>' +
      '<p class="simple-proofline">旧公式回测：12 个月少于标普 1.82%，170 个检验 0 个通过，所以已经删除。</p>' +
      '</section>' +
      '<section class="card simple-data"><b>数据状态</b><span>覆盖 ' + esc(list.length || 0) + ' 家公司</span>' +
      '<span>每天研究 3 家</span><span>长期视角：3 年以上</span></section>' +
      '</div>';
  }

  const DEEP_STATUS_LABEL = { pick: '值得关注', watch: '继续等待', rejected: '不建议买' };
  // 旧简报里 note 只有文字没有 status 字段;research.js 的 statusLabel 用的是「建议买/等待/未采用」,
  // 早期版本还用过「建议等/不建议」。两代都要认,否则会被归进「其他」(实测 12 条里 11 条被归错)。
  const DEEP_STATUS_LEGACY = { 建议买: '值得关注', 建议等: '继续等待', 等待: '继续等待', 不建议: '不建议买', 未采用: '不建议买' };

  // 供 node 自测导出;浏览器中 module 未定义,自动跳过
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildChartSVG: buildChartSVG, computeChartLayout: computeChartLayout, niceDomain: niceDomain,
      money: money, signedPct: signedPct, deltaHTML: deltaHTML, esc: esc,
      buildStatRowHTML: buildStatRowHTML, buildChartBlockHTML: buildChartBlockHTML, buildTimingHTML: buildTimingHTML,
      timingDotClass: timingDotClass, timingViewPlain: timingViewPlain,
      plainifyBackendCopy: plainifyBackendCopy, plainifyAiNote: plainifyAiNote, changesCardHTML: changesCardHTML, deepStatusLabel: deepStatusLabel,
      verdictDotClass: verdictDotClass, buildRetroFactsHTML: buildRetroFactsHTML,
      secHTML: secHTML, firstDefined: firstDefined, firstNum: firstNum, assessDot: assessDot,
      pctileLabel: pctileLabel, qSeqBar: qSeqBar, qDivBar: qDivBar, quantBarsHTML: quantBarsHTML, vtRiskHTML: vtRiskHTML,
      scoreBreakdownHTML: scoreBreakdownHTML, scoreMethodNoteHTML: scoreMethodNoteHTML, SCORE_PART_DEFS: SCORE_PART_DEFS,
      todayPicksStripHTML: todayPicksStripHTML, locateTicker: locateTicker,
      rosterAsRows: rosterAsRows, rosterStatusToCall: rosterStatusToCall,
      shouldShowBackToToday: shouldShowBackToToday, urlWithoutDate: urlWithoutDate,
      buildStatsBarHTML: buildStatsBarHTML, statusChipHTML: statusChipHTML, rosterLegendHTML: rosterLegendHTML, scanOnlyHTML: scanOnlyHTML,
      pickDataHTML: pickDataHTML, pickTextHTML: pickTextHTML, pickDetailHTML: pickDetailHTML,
      investmentMemoHTML: investmentMemoHTML, researchPanelHTML: researchPanelHTML, watchlistRowHTML: watchlistRowHTML,
      leaderboardRowBodyHTML: leaderboardRowBodyHTML, lbShouldFill: lbShouldFill,
      rosterItemHTML: rosterItemHTML, renderAnalysisSectionHTML: renderAnalysisSectionHTML,
      perfEntryHTML: perfEntryHTML, perfSummaryHTML: perfSummaryHTML, perfCallHTML: perfCallHTML,
      perfTrendHTML: perfTrendHTML, perfSparkHTML: perfSparkHTML,
      perfSampleStats: perfSampleStats, perfSampleBarHTML: perfSampleBarHTML,
      perfBlockedHTML: perfBlockedHTML, medianOf: medianOf, PERF_SAMPLE_TARGET: PERF_SAMPLE_TARGET,
      providerOf: providerOf, providerBadgeHTML: providerBadgeHTML, providerNoteHTML: providerNoteHTML,
      researchModelLabel: researchModelLabel,
      pendingRevalidationRows: pendingRevalidationRows, revalidationReason: revalidationReason,
      pendingRevalidationHTML: pendingRevalidationHTML,
      perfReviewHTML: perfReviewHTML, perfPickRowHTML: perfPickRowHTML, perfPicksHTML: perfPicksHTML,
      filterRows: filterRows, rowAction: rowAction, lbFacets: lbFacets,
      rowBuyConfidence: rowBuyConfidence, isLegacyConfidence: isLegacyConfidence,
      hasNativeConfidence: hasNativeConfidence,
      isActionableBuyRow: isActionableBuyRow, isActionableSellRow: isActionableSellRow,
      confidencePresentation: confidencePresentation, meterHTML: meterHTML,
      ageMeta: ageMeta, lbFreshnessHTML: lbFreshnessHTML, todayActionsHTML: todayActionsHTML,
      aiRanInBrief: aiRanInBrief, aiOutageCause: aiOutageCause, aiOutageBannerHTML: aiOutageBannerHTML,
      backendOutageTextUsable: backendOutageTextUsable,
      markFor: markFor, calendarAiRan: calendarAiRan, methodHTML: methodHTML, simpleMethodHTML: simpleMethodHTML, v32MethodHTML: v32MethodHTML, regimeCardHTML: regimeCardHTML, positionRiskCardHTML: positionRiskCardHTML, actionCenterHTML: actionCenterHTML, v32CardsHTML: v32CardsHTML, v32AccuracyHTML: v32AccuracyHTML, forwardTableHTML: forwardTableHTML, lockLineHTML: lockLineHTML, whyBoughtHTML: whyBoughtHTML, reviewPackHTML: reviewPackHTML,
      briefPendingHTML: briefPendingHTML, briefDayDiff: briefDayDiff, DAILY_RUN_HHMM: DAILY_RUN_HHMM,
      v3DecisionOfRow: v3DecisionOfRow, simpleEvidenceFactsHTML: simpleEvidenceFactsHTML,
      simpleDirectionMeta: simpleDirectionMeta, simpleForecastOf: simpleForecastOf,
      simpleForecastLeadHTML: simpleForecastLeadHTML, simpleHomeHTML: simpleHomeHTML,
      holdingStructureHTML: holdingStructureHTML, HOLD_TABLE: HOLD_TABLE,
      sliceForRender: sliceForRender, leaderboardCounts: leaderboardCounts,
      bandMeta: bandMeta, callMeta: callMeta, callBadgeHTML: callBadgeHTML, lbScoreBarHTML: lbScoreBarHTML,
      leaderboardRowHTML: leaderboardRowHTML, leaderboardExplainerHTML: leaderboardExplainerHTML,
      auditCardHTML: auditCardHTML, auditIssueMeta: auditIssueMeta,
      leaderboardCountsHTML: leaderboardCountsHTML, leaderboardControlsHTML: leaderboardControlsHTML,
      leaderboardEntryHTML: leaderboardEntryHTML,
      formatMarketAsOf: formatMarketAsOf, marketFreshnessHTML: marketFreshnessHTML,
      GLOSSARY: GLOSSARY, glossaryEntry: glossaryEntry, glossaryTermHTML: glossaryTermHTML,
      glossaryPopupHTML: glossaryPopupHTML, glossaryListHTML: glossaryListHTML,
      glossaryLinkify: glossaryLinkify,
      CONFIDENCE_LABEL: CONFIDENCE_LABEL, CONFIDENCE_CAVEAT: CONFIDENCE_CAVEAT
    };
  }
  // node 环境(无 document)到此为止,以下皆为浏览器 DOM 逻辑
  if (typeof document === 'undefined') return;

  /* ---------- DOM 句柄 ---------- */
  const briefRegion = document.getElementById('briefRegion');
  const calCard = document.getElementById('calCard');
  let calHasContent = false; // 日历是否已有内容(索引加载完);perf/retro 页隐藏日历,回主页按此恢复
  const pushBtn = document.getElementById('pushBtn');
  const shareBtn = document.getElementById('shareBtn');

  /* ---------- 常量 ---------- */
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CAL_COLLAPSE_KEY = 'sa.calCollapsed'; // 月历折叠态 localStorage 键
  const CHART_RANGE_KEY = 'sa.chartRange';    // 走势图区间(1m/1y)localStorage 键
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------- 运行时状态 ---------- */
  let indexData = [];        // /api/briefs 索引数组
  let selectedDate = null;   // 当前查看的简报日期(YYYY-MM-DD)
  let calYear = 0;           // 月历当前显示年
  let calMonth = 0;          // 月历当前显示月(0-11)
  let chartUidSeq = 0;       // 走势图 uid 自增(保证同页多图渐变 id 不冲突)
  let retroData = null;      // /api/retro 月度回顾数据(404/缺失则保持 null,不渲染入口)
  let perfData = null;       // /api/performance 历史成绩单数据(404/缺失则保持 null,不渲染入口)
  let leaderboardData = null;// /api/leaderboard/latest 全市场排行榜(404/缺失则保持 null,回退旧 roster)
  let leaderboardReady = false; // 首次请求结束前首屏显示同步态,避免把未到达的榜单误报成「无需操作」
  let auditData = null;      // /api/audit/latest 最近一次审计(404/缺失则不渲染审计卡)
  let perfHistory = null;    // /api/performance-history 每日成绩快照(趋势图数据)
  let liveMarketOverview = null; // /api/market 独立延迟行情；失败则退回简报快照
  let currentBrief = null;   // 当前日简报对象(排行榜异步到达后据此重渲染,补上量化/评分数据)
  let viewMode = 'brief';    // 当前视图:'brief' | 'retro' | 'perf'
  let latestDate = null;     // 最新简报日期(= /api/latest 或索引最大日期);「回到今日」目标
  let currentLbReveal = null;// 当前主页统一榜单的「定位并展开某 ticker」函数(strip 点击用);无榜单为 null
  let perfLoadPromise = null;// 成绩单较大,手机慢网下避免重复请求与错误切页

  const GET_RETRY_DELAYS_MS = [350, 900];
  const LATEST_BRIEF_CACHE_KEY = 'sa.latestBrief.v1';

  /* ==================== 小工具 ==================== */

  // 所有卡片都从这里进 DOM,所以术语解释链接**只在这一处**挂载:
  // 纯函数保持输出干净(便于测试直接断言文案),链接在注入浏览器的最后一刻才加。
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = glossaryLinkify(html.trim());
    return t.content.firstElementChild;
  }

  // 洛杉矶今天(与后端同口径)
  function laToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  // 价值陷阱风险文案首字 → 状态色 class(低/中/高)
  function vtDotClass(vt) {
    const c = String(vt || '')[0];
    if (c === '高') return 'dot-crit';
    if (c === '中') return 'dot-warn';
    if (c === '低') return 'dot-good';
    return 'dot-none';
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // GitHub Pages 是稳定的公开入口；它没有 Express 路由，因此只读 API 使用每日导出的
  // JSON 快照。家庭服务器/Cloudflare Tunnel 仍使用原始 /api/* 路由。
  function readAPIURL(url) {
    if (location.hostname !== 'leoyang6.github.io' || typeof url !== 'string' || url.indexOf('/api/') !== 0) {
      return url;
    }
    const parsed = new URL(url, location.origin);
    if (parsed.pathname === '/api/review-pack') {
      const ticker = parsed.searchParams.get('ticker');
      return ticker ? '/api/review-pack/' + encodeURIComponent(ticker) + '.json' : '/api/review-pack.json';
    }
    return parsed.pathname + '.json';
  }

  // Quick Tunnel 曾出现短暂 QUIC 断流:页面壳来自 SW,但 /api/latest 当次 fetch 失败。
  // GET 读请求对网络错误/429/5xx 做两次短重试;404 等业务结果不重试。
  async function getJSON(url, options) {
    const opts = options || {};
    const delays = opts.retries === false ? [] : GET_RETRY_DELAYS_MS;
    let lastError = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const r = await fetch(readAPIURL(url), {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!r.ok) {
          const e = new Error('HTTP ' + r.status);
          e.status = r.status;
          if (r.status < 500 && r.status !== 429) throw e;
          lastError = e;
        } else {
          return await r.json();
        }
      } catch (e) {
        if (e && e.status && e.status < 500 && e.status !== 429) throw e;
        lastError = e;
      }
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
    throw lastError || new Error('network unavailable');
  }

  function saveLatestBriefCache(brief) {
    if (!brief || typeof brief !== 'object' || !brief.date) return;
    try {
      localStorage.setItem(LATEST_BRIEF_CACHE_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        brief: brief,
      }));
    } catch (e) { /* Safari 私密模式/容量不足时不影响在线主流程 */ }
  }

  function loadLatestBriefCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(LATEST_BRIEF_CACHE_KEY) || 'null');
      if (!saved || !saved.brief || typeof saved.brief !== 'object' || !saved.brief.date) return null;
      return saved;
    } catch (e) { return null; }
  }

  /* ==================== 术语解释弹窗 ====================
     全站只有一个弹窗节点,用事件委托接住所有 .gl-term 点击(榜单是分批渲染的,
     逐个绑监听既漏又泄漏)。弹窗容器懒创建,不占首屏。 */

  let glossaryModal = null;
  function ensureGlossaryModal() {
    if (glossaryModal) return glossaryModal;
    const wrap = document.createElement('div');
    wrap.className = 'gl-modal';
    wrap.hidden = true;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = '<div class="gl-backdrop"></div>' +
      '<div class="gl-panel"><button type="button" class="gl-close" aria-label="关闭">×</button>' +
      '<div class="gl-body"></div></div>';
    wrap.querySelector('.gl-backdrop').addEventListener('click', closeGlossary);
    wrap.querySelector('.gl-close').addEventListener('click', closeGlossary);
    document.body.appendChild(wrap);
    glossaryModal = wrap;
    return wrap;
  }

  function closeGlossary() {
    if (glossaryModal) glossaryModal.hidden = true;
  }

  function openGlossary(term) {
    const html = glossaryPopupHTML(term);
    if (!html) return false;               // 没词条就当没这回事,不弹空窗
    const m = ensureGlossaryModal();
    m.querySelector('.gl-body').innerHTML = html;
    m.hidden = false;
    const close = m.querySelector('.gl-close');
    if (close && typeof close.focus === 'function') close.focus();
    return true;
  }

  document.addEventListener('click', function (ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('.gl-term') : null;
    if (!t) return;
    // 术语按钮常常躺在 <details>/榜单行里,不拦住冒泡会顺手把整行折叠掉
    ev.preventDefault();
    ev.stopPropagation();
    openGlossary(t.getAttribute('data-term'));
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeGlossary();
  });

  /* ==================== 简报渲染 ==================== */

  // 主页信息架构(合并版):简报头(含「回到今日」)+ 市场概览 + 今日建议买 strip / 无推荐卡 + 统一榜单 + 研究轨迹。
  // 不再渲染完整 pick 大卡、独立观察清单、「今日前 20」独立区块与排行榜入口卡——全部并入统一榜单。
  /* ---------- 场次(一天3场)与变化对比 ---------- */

  const SESSION_ORDER = ['premarket', 'close', 'evening'];
  const SESSION_LABELS = { premarket: '早盘前', close: '收盘', evening: '晚间' };
  // 当日已见过的场次(旧场次存档里 sessions 列表可能不全,这里做并集缓存)
  let daySessCache = { date: null, list: [] };

  // ISO 时间 → 洛杉矶 HH:mm(与后端日期口径一致)
  function fmtLATime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch (e) { return ''; }
  }

  // 场次条:「收盘版 · 13:22 分析完成」+ 多场时的切换 chips。无场次信息(旧简报)只显示时间。
  function buildSessionBar(brief) {
    const s = brief.session || null;
    const t = fmtLATime(brief.generatedAt);
    if (!s && !t) return null;
    if (brief.date !== daySessCache.date) daySessCache = { date: brief.date, list: [] };
    const fromBrief = Array.isArray(brief.sessions) ? brief.sessions : (s ? [s.key] : []);
    daySessCache.list = SESSION_ORDER.filter(function (k) {
      return daySessCache.list.indexOf(k) !== -1 || fromBrief.indexOf(k) !== -1;
    });
    let chips = '';
    if (daySessCache.list.length > 1) {
      chips = daySessCache.list.map(function (k) {
        return '<button type="button" class="sess-chip' + (s && s.key === k ? ' active' : '') + '" data-k="' + k + '">'
          + (SESSION_LABELS[k] || k) + '</button>';
      }).join('');
    }
    const node = el(
      '<div class="session-bar">' +
        '<span class="sess-time">' + esc(s ? s.label + '版' : '') + (t ? (s ? ' · ' : '') + t + ' 分析完成' : '') + '</span>' +
        (chips ? '<span class="sess-chips">' + chips + '</span>' : '') +
      '</div>'
    );
    Array.prototype.slice.call(node.querySelectorAll('.sess-chip')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('active')) return;
        loadBrief(brief.date, btn.getAttribute('data-k'));
      });
    });
    return node;
  }

  // 本场新研究条目的结论档:优先结构化 status(pick/watch/rejected),回退解析 note 里的中文标签。
  // 注意 note 是后端历史文案,里面可能还是旧词,所以两套写法都认;展示时一律用新词。
  function deepStatusLabel(i) {
    if (i.status && DEEP_STATUS_LABEL[i.status]) return DEEP_STATUS_LABEL[i.status];
    const m = String(i.note || '').match(/值得关注|继续等待|不建议买|建议买|建议等|不建议|等待|未采用/);
    if (!m) return '其他';
    return DEEP_STATUS_LEGACY[m[0]] || m[0];
  }

  // 「较上一场变化」卡(行动变化置顶、噪声折叠):
  //   ① 买入榜进出(最重要,进绿/出黄,大 chip)② 评级变动(观察↔不建议/信心)③ 本场新深挖折叠成一行摘要。
  //   首场(changes=null)不渲染;无变化 → 一行「维持」。任意 ticker 可点,榜单定位。
  // 纯字符串版:只拼 HTML,不碰 DOM,便于 node 侧做「用户可见文字里不许有黑话」的回归扫描。
  // 无 changes → null;无变化 → 一行「维持」。
  function changesCardHTML(brief) {
    const ch = brief && brief.changes;
    if (!ch) return null;
    const items = Array.isArray(ch.items) ? ch.items : [];
    const prevT = fmtLATime(ch.prev_generated_at);
    const head = '较' + (ch.prev_session || '上一场') + (prevT ? '(' + prevT + ')' : '');
    if (items.length === 0) {
      return '<section class="card changes-card changes-none">' +
        '<span class="dot dot-none"></span><span>' + esc(head) + ' 无变化,结论维持</span></section>';
    }

    const picksIn = [], picksOut = [], flips = [], newDeep = [];
    items.forEach(function (i) {
      if (i.type === 'pick_new') picksIn.push(i);
      else if (i.type === 'pick_removed') picksOut.push(i);
      else if (i.type === 'new_deep') newDeep.push(i);
      else flips.push(i); // status / conviction 变动
    });

    function tickerChip(ticker, cls) {
      return '<button type="button" class="chg-chip ' + cls + '" data-ticker="' + esc(ticker) + '">' + esc(ticker) + '</button>';
    }
    function chgRow(tag, tagCls, chips) {
      return '<div class="chg-row"><span class="chg-tag ' + tagCls + '">' + esc(tag) + '</span>' + chips + '</div>';
    }

    // 标题 + 一句话摘要
    const sumBits = [];
    if (picksIn.length || picksOut.length) sumBits.push('关注名单 ＋' + picksIn.length + ' / －' + picksOut.length);
    if (flips.length) sumBits.push('结论改了 ' + flips.length);
    if (newDeep.length) sumBits.push('新研究 ' + newDeep.length);
    let html = '<div class="chg-head"><span class="chg-title">🆕 ' + esc(head) + '</span>' +
      '<span class="chg-sub">' + esc(sumBits.join(' · ')) + '</span></div>';

    // ① 买入榜(最重要)
    if (picksIn.length || picksOut.length) {
      let s = '<div class="chg-sec"><div class="chg-sec-label">「值得关注」名单的变化</div>';
      if (picksIn.length) s += chgRow('＋ 新入', 'chg-tag--in',
        picksIn.map(function (i) { return tickerChip(i.ticker, 'chg-chip--in'); }).join(''));
      if (picksOut.length) s += chgRow('－ 移出', 'chg-tag--out',
        picksOut.map(function (i) { return tickerChip(i.ticker, 'chg-chip--out'); }).join(''));
      s += '</div>';
      html += s;
    }

    // ② 评级变动(观察↔不建议、信心增减)
    if (flips.length) {
      const lis = flips.map(function (i) {
        return '<li data-ticker="' + esc(i.ticker) + '"><b>' + esc(i.ticker) + '</b>' +
          // i.note 是 tools/research.js buildChanges 拼的**代码模板**(不是 AI 自由文本),
          // 所以要过一遍人话补丁,否则「建议买」「买入把握」会直接上屏(见 BACKEND_PLAIN)。
          '<span class="chg-note">' + esc(plainifyBackendCopy(i.note || '')) + '</span></li>';
      }).join('');
      html += '<div class="chg-sec"><div class="chg-sec-label">结论改了的</div>' +
        '<ul class="changes-list">' + lis + '</ul></div>';
    }

    // ③ 本场新深挖 → 折叠成一行摘要,点开看分组
    if (newDeep.length) {
      const order = ['值得关注', '继续等待', '不建议买', '其他'];
      const byStatus = {};
      newDeep.forEach(function (i) { const k = deepStatusLabel(i); (byStatus[k] = byStatus[k] || []).push(i); });
      const present = order.filter(function (k) { return byStatus[k]; });
      const countTxt = present.map(function (k) { return byStatus[k].length + ' ' + k; }).join(' · ');
      const groups = present.map(function (k) {
        const cls = k === '值得关注' ? 'chg-chip--in' : k === '不建议买' ? 'chg-chip--out' : 'chg-chip--neutral';
        const tagCls = k === '值得关注' ? 'chg-tag--in' : k === '不建议买' ? 'chg-tag--out' : 'chg-tag--neutral';
        return chgRow(k, tagCls, byStatus[k].map(function (i) { return tickerChip(i.ticker, cls); }).join(''));
      }).join('');
      html += '<details class="chg-deep"><summary>这一场新研究了 <b>' + newDeep.length + '</b> 只 · ' +
        esc(countTxt) + '</summary><div class="chg-deep-body">' + groups + '</div></details>';
    }

    return '<section class="card changes-card">' + html + '</section>';
  }

  function buildChangesCard(brief) {
    const markup = changesCardHTML(brief);
    if (!markup) return null;
    const node = el(markup);
    // 任意 ticker(chip 或列表项)→ 榜单定位并展开
    Array.prototype.slice.call(node.querySelectorAll('[data-ticker]')).forEach(function (elm) {
      elm.addEventListener('click', function (e) {
        e.stopPropagation();
        const t = elm.getAttribute('data-ticker');
        if (t && typeof currentLbReveal === 'function') currentLbReveal(t);
      });
    });
    return node;
  }

  // 只是把纯函数的 HTML 挂进 DOM;判断与文案全在 aiOutageBannerHTML(可被测试锁住)
  function buildStaticBanner(brief) {
    const html = aiOutageBannerHTML(brief);
    return html ? el(html) : null;
  }

  function renderSimple(brief) {
    briefRegion.innerHTML = '';
    currentLbReveal = null;
    if (!brief || typeof brief !== 'object') {
      briefRegion.appendChild(el('<section class="card empty"><p class="empty-text">暂无简报。</p></section>'));
      return;
    }
    const meta = brief.meta || {};
    briefRegion.appendChild(renderHead(brief.date, meta.mock, meta.backfill === true));
    applyBackToToday();
    if (brief.__fromLastSuccessfulCache) {
      briefRegion.appendChild(el('<section class="card empty"><p class="empty-text">网络暂时不稳定，下面显示上次成功读取的真实简报（' +
        esc(brief.date) + '）。联网后重新打开会自动更新。</p></section>'));
    }
    if (brief.error) {
      briefRegion.appendChild(el('<section class="card simple-hero"><span class="simple-kicker">运行状态</span>' +
        '<h2>今天的研究失败了</h2><p>' + esc(brief.error) + '</p></section>'));
      return;
    }
    const info = leaderboardForBrief(brief);
    const home = el(simpleHomeHTML(brief, info.rows, {
      aiRan: aiRanInBrief(brief),
    }));
    briefRegion.appendChild(home);
    // v3.2:首页同样要能看到市场方向与持仓风险(与详细视图同一套纯函数;
    // API 失败时就地退回简报内嵌值,再失败显示缺失态)。
    try {
      if (!document.getElementById('v32-cards')) briefRegion.appendChild(el(v32CardsHTML()));
      loadV32Cards();
    } catch (e) { /* 卡片挂载失败不影响今日结论 */ }

    const rowsByTicker = Object.create(null);
    info.rows.forEach(function (row) {
      if (row && row.ticker) rowsByTicker[String(row.ticker).toUpperCase()] = row;
    });
    const analysisByTicker = simpleHomeAnalysisMap(brief);

    function wireSimpleChart(det, full) {
      const block = det.querySelector('.chart-block');
      if (block && full && full.market_data) {
        try { wireChart(block, full.market_data); } catch (e) { /* 图表失败不影响长文和来源 */ }
      }
    }

    Array.prototype.slice.call(home.querySelectorAll('.simple-result')).forEach(function (det, idx) {
      const ticker = String(det.getAttribute('data-ticker') || '').toUpperCase();
      if (det.getAttribute('data-ready') === '1') wireSimpleChart(det, analysisByTicker[ticker]);
      det.addEventListener('toggle', function () {
        if (!det.open || det.getAttribute('data-ready') === '1' || det.getAttribute('data-loading') === '1') return;
        const row = rowsByTicker[ticker];
        const date = det.getAttribute('data-analysis-date');
        const body = det.querySelector('.simple-detail');
        if (!row || !date || !body) return;
        det.setAttribute('data-loading', '1');
        getJSON('/api/analysis/' + encodeURIComponent(date) + '/' + encodeURIComponent(ticker)).then(function (full) {
          analysisByTicker[ticker] = full;
          body.innerHTML = glossaryLinkify(leaderboardRowBodyHTML(row, 'simpleLazy' + idx, full, null));
          det.setAttribute('data-ready', '1');
          det.removeAttribute('data-loading');
          wireSimpleChart(det, full);
        }).catch(function () {
          det.removeAttribute('data-loading');
          body.innerHTML = '<p class="analysis-load-error">完整研究暂时读不出来，请稍后再试。卡片上的行情数据仍来自本次简报。</p>';
        });
      });
    });
  }

  function render(brief) {
    renderSimple(brief);
    return;
    briefRegion.innerHTML = '';
    currentLbReveal = null;
    if (!brief || typeof brief !== 'object') {
      briefRegion.appendChild(el('<section class="card empty"><p class="empty-text">暂无简报。</p></section>'));
      return;
    }

    const meta = brief.meta || {};
    briefRegion.appendChild(renderHead(brief.date, meta.mock, meta.backfill === true));
    applyBackToToday(); // 若所选日期非最新 → 头部注入「← 回到今日」

    // 场次条(一天3场:早盘前/收盘/晚间):最后分析时间 + 场次切换
    const sessBar = buildSessionBar(brief);
    if (sessBar) briefRegion.appendChild(sessBar);

    // 失败简报:只有 error 字段
    if (brief.error) {
      briefRegion.appendChild(el(
        '<section class="card">' +
          '<div class="fail-head"><span class="dot dot-crit"></span><span class="fail-title">研究失败</span></div>' +
          '<p class="fail-text">' + esc(brief.error) + '</p>' +
        '</section>'
      ));
      return;
    }

    // AI 没跑成的日子:先说这句,再谈股票。放在名单之前是故意的——榜单里那些买入行
    // 是以前分析的旧结论,用户必须先知道今天没人重新判断过(v2.2 A2)。
    const aiRan = aiRanInBrief(brief);
    const staticBanner = buildStaticBanner(brief);
    if (staticBanner) briefRegion.appendChild(staticBanner);

    // 首屏先给结论:机会/风险各取最需关注 3 只并排高亮。
    const lbInfo = leaderboardForBrief(brief);
    const actCard = el(todayActionsHTML(lbInfo.rows, brief.no_pick_reason, {
      refDate: brief.date,
      aiRan: aiRan,
      fallbackReason: meta.fallback_reason || '',
      loading: !leaderboardReady
    }));
    briefRegion.appendChild(actCard);

    // 「怎么拿」紧跟在今日重点后面:上一张卡刚说完「先看这 3 只」,这张卡必须马上补上
    // 「只买 3 只,十年跑赢大盘的可能性只有 41.5%」——否则等于默许用户把它当成买 3 只的清单。
    // 第 13 轮实验结论(RUBRIC §0.18):这三件事的作用比榜单上任何分数都大一个数量级。
    briefRegion.appendChild(el(holdingStructureHTML()));

    // 待复核清单:服务端已判定「旧依据不达标」的那批,单列一块。故意排在今日行动之外,
    // 门槛逻辑一点没动——只是不再假装它们不存在。
    const revHTML = pendingRevalidationHTML(lbInfo.rows, { refDate: brief.date });
    const revCard = revHTML ? el(revHTML) : null;
    if (revCard) briefRegion.appendChild(revCard);

    // 「较上一场变化」只在真做了新判断时才有意义:AI 没跑就没有可比的新结论。
    const changesCard = aiRan ? buildChangesCard(brief) : null;
    if (changesCard) briefRegion.appendChild(changesCard);

    const canUseLiveMarket = !!(liveMarketOverview && latestDate && brief.date === latestDate);
    const mo = canUseLiveMarket ? liveMarketOverview : brief.market_overview;
    const hasMo = !!(mo && Array.isArray(mo.indices) && mo.indices.length);
    if (brief.market_summary || hasMo) {
      let moHTML = '';
      if (hasMo) {
        const chips = mo.indices.map(function (x) {
          const d = x.changeDayPct;
          const cls = d == null ? '' : d >= 0 ? ' mkt-chip--up' : ' mkt-chip--down';
          const pct = d == null ? '—' : signedPct(d);
          const px = x.price == null ? ''
            : (x.symbol === '^VIX' ? fmtNum(x.price, 2) : fmtNum(x.price, 0));
          return '<span class="chip mkt-chip' + cls + '">' + esc(x.label) +
            (px ? ' ' + esc(px) : '') + ' <b>' + esc(pct) + '</b></span>';
        }).join('');
        moHTML = '<div class="mkt-chips">' + chips + '</div>' +
          (mo.summary
            ? '<p class="sec-body mkt-tone">' + esc(plainifyBackendCopy(mo.summary)) + '</p>' : '') +
          marketFreshnessHTML(mo);
      }
      briefRegion.appendChild(el(
        '<section class="card market">' +
          '<div class="block-title">市场概览</div>' +
          moHTML +
          // market_summary 是后端代码模板拼的,先过一遍名词补丁再显示(见 plainifyBackendCopy)
          (brief.market_summary
            ? '<p class="sec-body">' + esc(plainifyBackendCopy(brief.market_summary)) + '</p>' : '') +
        '</section>'
      ));
    }

    // v3.2:方向卡 + 持仓风险卡。先占位后异步填充,任何失败都不影响简报主体。
    try {
      briefRegion.appendChild(el(v32CardsHTML()));
      loadV32Cards();
    } catch (e) { /* 占位失败也不挡住榜单 */ }

    // 统一榜单默认收起(用户要求:别一上来摊 500 只数据),点开才见筛选/搜索/全表
    const lbWrap = buildHomeLeaderboard(brief);
    const c = leaderboardCounts(lbInfo.lbForCounts);
    const lbDetails = el('<details class="lb-collapse"><summary class="lb-collapse-sum">📊 全市场排行榜 ' +
      esc(c.screened) + ' 只 · ' + esc(c.deep) + ' 只有 AI 结论<span class="lb-caret" aria-hidden="true">›</span></summary></details>');
    lbDetails.appendChild(lbWrap);
    briefRegion.appendChild(lbDetails);
    // 定位某 ticker 前先展开折叠的榜单(操作卡/变化卡点击都走 currentLbReveal)
    const innerReveal = currentLbReveal;
    currentLbReveal = function (t) { lbDetails.open = true; if (innerReveal) innerReveal(t); };
    Array.prototype.slice.call(actCard.querySelectorAll('.act-item')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const t = btn.getAttribute('data-ticker');
        if (t && typeof currentLbReveal === 'function') currentLbReveal(t);
      });
    });
    // 待复核项点击 → 同样在全市场排行榜里定位并展开该股票
    if (revCard) {
      Array.prototype.slice.call(revCard.querySelectorAll('.rev-item')).forEach(function (btn) {
        btn.addEventListener('click', function () {
          const t = btn.getAttribute('data-ticker');
          if (t && typeof currentLbReveal === 'function') currentLbReveal(t);
        });
      });
    }
    Array.prototype.slice.call(actCard.querySelectorAll('[data-action-filter]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const f = btn.getAttribute('data-action-filter');
        lbDetails.open = true;
        const chip = lbDetails.querySelector('.lb-chip[data-filter="' + f + '"]');
        if (chip) chip.click();
        try { lbDetails.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        catch (e) { try { lbDetails.scrollIntoView(); } catch (e2) { /* 忽略 */ } }
      });
    });

    const trail = renderTrail(brief);
    if (trail) briefRegion.appendChild(trail);
  }

  // 「今日建议买」strip(DOM):纯字符串生成 → 每项点击 = 在统一榜单定位并展开对应行。picks 全无效 → null。
  function buildPicksStrip(picks) {
    const node = el(todayPicksStripHTML(picks));
    if (!node) return null;
    Array.prototype.slice.call(node.querySelectorAll('.pk-item')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const t = btn.getAttribute('data-ticker');
        if (t && typeof currentLbReveal === 'function') currentLbReveal(t);
      });
    });
    return node;
  }

  // (2026-07-28 删除 buildNopickCard:定义后从无调用方的死代码,里面那句「Static 榜已更新。」
  //  用户根本看不到,却是内部黑话。今日无结论的说明现由 todayActionsHTML + aiOutageBannerHTML 负责。)

  // 统一榜单的数据源:优先 /api/leaderboard/latest(与该简报同日),否则回退把 brief.roster 当榜单渲染。
  function leaderboardForBrief(brief) {
    if (leaderboardData && Array.isArray(leaderboardData.rows) && leaderboardData.date &&
        brief && brief.date === leaderboardData.date) {
      const rows = leaderboardData.rows.filter(function (r) { return r && typeof r === 'object'; });
      return { rows: rows, weights: leaderboardData.weights || null, lbForCounts: leaderboardData, mode: 'full' };
    }
    const rows = rosterAsRows(brief && brief.roster);
    return { rows: rows, weights: null, lbForCounts: { rows: rows, count: rows.length }, mode: 'roster' };
  }

  // 统一榜单(DOM):标题 + 计数 + 双含义说明 + 粘顶搜索/过滤 + 增量列表(前 60 行 + 加载更多;过滤/搜索作用于全量)。
  // deep 行合并 brief.roster 深挖数据;展开行 lazy 生成(含评分分解面板)。返回容器节点。
  function buildHomeLeaderboard(brief) {
    const info = leaderboardForBrief(brief);
    const allRows = info.rows;
    const weights = info.weights;
    const PAGE = 60;

    const wrap = document.createElement('div');
    wrap.className = 'lb-home';
    // 标题由外层折叠 summary 承载(主页默认收起),此处不再重复
    const refDate = (brief && brief.date) || null;
    wrap.appendChild(el(leaderboardCountsHTML(leaderboardCounts(info.lbForCounts))));
    const freshHTML = lbFreshnessHTML(allRows, refDate);
    if (freshHTML) wrap.appendChild(el(freshHTML));
    wrap.appendChild(el(leaderboardExplainerHTML()));

    const controls = el(leaderboardControlsHTML(lbFacets(allRows)));
    wrap.appendChild(controls);

    const listCard = el('<section class="card lb-list"></section>');
    const listEl = el('<div class="lb-rows"></div>');
    const emptyEl = el('<p class="lb-empty" hidden>无匹配标的。</p>');
    const moreBtn = el('<button class="lb-more" type="button" hidden>加载更多</button>');
    listCard.appendChild(listEl);
    listCard.appendChild(emptyEl);
    listCard.appendChild(moreBtn);
    wrap.appendChild(listCard);

    let query = '';
    let filter = 'all';
    let sector = 'all';
    let filtered = allRows.slice();
    let rendered = 0;
    let uidSeq = 0;

    // 当日简报的深挖项(按 ticker)——榜单 deep 行只带量化字段,AI 文字/走势图在此取用
    const rosterDeep = Object.create(null);
    const fetchedAnalysis = Object.create(null);
    const cbRoster = (brief && Array.isArray(brief.roster)) ? brief.roster : [];
    cbRoster.forEach(function (r) {
      if (r && r.ticker && r.analyzed === 'deep') rosterDeep[String(r.ticker).toUpperCase()] = r;
    });

    function mountLbBody(body, row, uid, ri, loadFailed) {
      // 展开体不走 el(),所以这里单独补一次术语解释链接(榜单里的 AI 正文正是最需要解释的地方)
      body.innerHTML = glossaryLinkify(leaderboardRowBodyHTML(row, uid, ri, weights) +
        (loadFailed ? '<p class="analysis-load-error">完整研究暂时读不出来，现在显示的是之前存下来的摘要和电脑算的数据。</p>' : ''));
      const md = (ri && ri.market_data) || row.market_data;
      const block = body.querySelector('.chart-block');
      if (block && md) { try { wireChart(block, md); } catch (e) { /* 忽略图表挂载错误 */ } }
    }

    // 展开体 lazy:优先用当前场次数据；若结论来自同日较早场次，则按分析日期取回完整长文。
    function wireLbRow(det, row, uid) {
      let filled = false;
      det.addEventListener('toggle', function () {
        if (!lbShouldFill(det.open, filled)) return;
        filled = true;
        const body = det.querySelector('.lb-body');
        if (!body) return;
        const ticker = String(row.ticker || '').toUpperCase();
        const ri = row.deep ? rosterDeep[ticker] : null;
        if (ri || !row.deep) {
          mountLbBody(body, row, uid, ri, false);
          return;
        }
        const analysisDate = row.analyzed_on || refDate;
        if (!analysisDate) {
          mountLbBody(body, row, uid, null, true);
          return;
        }
        body.innerHTML = '<div class="analysis-loading" role="status"><span class="analysis-loading-dot"></span>' +
          '<span>正在读取 ' + esc(ticker) + ' 的完整研究…</span></div>';
        const key = analysisDate + ':' + ticker;
        if (!fetchedAnalysis[key]) {
          fetchedAnalysis[key] = getJSON('/api/analysis/' + encodeURIComponent(analysisDate) + '/' + encodeURIComponent(ticker));
        }
        fetchedAnalysis[key].then(function (full) {
          rosterDeep[ticker] = full;
          mountLbBody(body, row, uid, full, false);
        }).catch(function () {
          delete fetchedAnalysis[key];
          mountLbBody(body, row, uid, null, true);
        });
      });
    }

    function appendBatch() {
      const next = filtered.slice(rendered, rendered + PAGE);
      const uids = [];
      let html = '';
      next.forEach(function (row) {
        const uid = row.deep ? 'lbh' + (++uidSeq) : '';
        uids.push(uid);
        // 深挖行把 AI 一句话结论(decision)直接放在行上,「分高但不建议」一眼看到原因
        const ri = row.deep ? rosterDeep[String(row.ticker).toUpperCase()] : null;
        html += leaderboardRowHTML(row, uid, (ri && ri.decision) || row.ai_note, refDate);
      });
      const frag = document.createElement('div');
      frag.innerHTML = html;
      const kids = Array.prototype.slice.call(frag.children);
      next.forEach(function (row, i) {
        const det = kids[i];
        if (det) wireLbRow(det, row, uids[i]);
      });
      while (frag.firstChild) listEl.appendChild(frag.firstChild);
      rendered += next.length;
      const remain = filtered.length - rendered;
      moreBtn.hidden = remain <= 0;
      if (remain > 0) moreBtn.textContent = '加载更多(剩余 ' + remain + ')';
      emptyEl.hidden = filtered.length !== 0;
    }

    function applyFilter() {
      filtered = filterRows(allRows, query, filter, sector);
      rendered = 0;
      listEl.innerHTML = '';
      appendBatch();
    }

    const search = controls.querySelector('.lb-search-input');
    if (search) search.addEventListener('input', function () { query = search.value || ''; applyFilter(); });

    const sectorSel = controls.querySelector('.lb-sector-sel');
    if (sectorSel) sectorSel.addEventListener('change', function () { sector = sectorSel.value || 'all'; applyFilter(); });

    const chips = Array.prototype.slice.call(controls.querySelectorAll('.lb-chip'));
    function setActiveChip(f) {
      chips.forEach(function (c) {
        const on = c.getAttribute('data-filter') === f;
        c.classList.toggle('on', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        filter = chip.getAttribute('data-filter') || 'all';
        setActiveChip(filter);
        applyFilter();
      });
    });

    moreBtn.addEventListener('click', appendBatch);

    // 滚动到底自动增量渲染:sentinel = moreBtn(隐藏时不触发,显现且入视口才加载)
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && rendered < filtered.length) appendBatch();
        });
      }, { rootMargin: '400px' });
      io.observe(moreBtn);
    }

    // 「今日建议买」strip 点击:重置过滤/搜索 → 定位 → 补渲染到目标 → 展开 + 滚动
    currentLbReveal = function (ticker) {
      query = '';
      filter = 'all';
      sector = 'all';
      if (search) search.value = '';
      if (sectorSel) sectorSel.value = 'all';
      setActiveChip('all');
      applyFilter();
      const idx = locateTicker(filtered, ticker);
      if (idx < 0) return;
      let guard = 0;
      while (rendered <= idx && rendered < filtered.length && guard++ < 100) appendBatch();
      const t = String(ticker == null ? '' : ticker).toUpperCase();
      const list = Array.prototype.slice.call(listEl.querySelectorAll('.lb-row'));
      let target = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].getAttribute('data-ticker') === t) { target = list[i]; break; }
      }
      if (!target) target = listEl.children[idx] || null;
      if (target) {
        if (!target.open) target.open = true;
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (e) { try { target.scrollIntoView(); } catch (e2) { /* 忽略 */ } }
      }
    };

    applyFilter();
    return wrap;
  }

  // 「回到今日」:非最新日期时在简报头注入链接;回到最新则移除。链接点击清 ?date 并加载最新。
  function applyBackToToday() {
    const head = briefRegion.querySelector('.brief-head');
    if (!head) return;
    const existing = head.querySelector('.back-today');
    const show = viewMode === 'brief' && shouldShowBackToToday(selectedDate, latestDate);
    if (show) {
      if (!existing) {
        const link = el('<button class="back-today" type="button">← 回到今日</button>');
        link.addEventListener('click', goToToday);
        head.insertBefore(link, head.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function goToToday() {
    try { window.history.replaceState({}, '', urlWithoutDate(window.location.href)); } catch (e) { /* 忽略 */ }
    loadBrief(latestDate || null);
  }

  // 按 ticker 查当日 leaderboard 行(供量化评分条);无数据 / 未命中 → null
  function lbRowFor(ticker) {
    if (!ticker || !leaderboardData || !Array.isArray(leaderboardData.rows)) return null;
    const t = String(ticker).toUpperCase();
    const rows = leaderboardData.rows;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && String(r.ticker).toUpperCase() === t) return r;
    }
    return null;
  }

  function renderHead(date, mock, backfill) {
    let badges = '';
    if (mock) badges += '<span class="chip mock-badge">模拟数据</span>';
    // 回补简报徽章:与 mock 徽章可并存,弱文色
    if (backfill) badges += '<span class="chip backfill-badge">回补 · 基于当下信息回溯</span>';
    // A2:今天的简报还没生成时,在日期下方明确说出生成时间 + 当前展示的是哪天的结论,
    // 而不是让用户对着昨天的日期猜是不是坏了。只在看最新简报时出现(历史回看不打扰);
    // latestDate 尚未就绪的竞态下默认展示(文案本身为真,不误导)。
    let pending = '';
    try {
      const viewingLatest = (typeof latestDate !== 'string' || !latestDate) ? true : (date === latestDate);
      if (viewingLatest) pending = briefPendingHTML(date, laToday());
    } catch (e) { pending = ''; }
    return el('<div class="brief-head"><span class="brief-date">' + esc(date || '') + '</span>' + badges + pending + '</div>');
  }

  function meterHTML(pick) {
    const p = pick || {};
    const current = rowBuyConfidence({
      confidence_level: p.confidence_level,
      conviction: p.conviction,
    });
    const original = rowBuyConfidence({
      confidence_level: p.confidence_original,
      conviction: p.conviction_original,
    });
    const currentMeta = confidencePresentation(p);
    const n = current == null ? 0 : Math.max(0, Math.min(10, Math.round(current / 10)));
    let segs = '';
    for (let i = 0; i < 10; i++) segs += '<i' + (i < n ? ' class="on"' : '') + '></i>';
    let adj = '';
    if (original != null && current != null && original !== current) {
      if (currentMeta.legacy) {
        adj = '<div class="meter-adj">旧版评分先给了 ' + esc(original / 10) + '/10 · 调整后 '
          + esc(currentMeta.text) + '</div>';
      } else {
        adj = '<div class="meter-adj">AI 自己先给 ' + esc(original) + '/100 · 挑毛病的 AI 调整后 '
          + esc(current) + '/100</div>';
      }
    }
    return '<div class="meter-wrap"><div class="meter">' + segs + '</div>' +
      '<div class="meter-label" title="' + esc(CONFIDENCE_CAVEAT) + '">' +
      esc(currentMeta.label) + (currentMeta.legacy ? ' · 待重算 ' : ' ') +
      esc(currentMeta.text) +
      '</div>' + adj + '</div>';
  }

  function sourcesHTML(sources, label) {
    if (!Array.isArray(sources) || sources.length === 0) return '';
    const items = sources.map((s) => {
      const title = esc((s && s.title) || '来源');
      // URL 白名单:只有 http(s) 才渲染为可点链接,杜绝 javascript: 等注入
      const url = (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) ? s.url : null;
      const host = url ? hostOf(url) : '';
      const titleEl = url
        ? '<a class="source-title" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>'
        : '<span class="source-title plain">' + title + '</span>';
      const supports = s && s.supports ? '<div class="source-supports">' + esc(s.supports) + '</div>' : '';
      const hostEl = host ? '<div class="source-host">' + esc(host) + '</div>' : '';
      return '<div class="source-item">' + titleEl + supports + hostEl + '</div>';
    }).join('');
    return '<details class="sources"><summary>' + esc(label || '依据与来源') + '(' + sources.length + ')</summary>' +
      '<div class="source-list">' + items + '</div></details>';
  }

  function renderPick(p) {
    // pick-head + 信心条 + 数据可视化区默认可见;文字区收进「查看完整分析」(flat:false)。
    // 量化评分条数据取当日 leaderboard 同 ticker 行。
    const uid = 'p' + (++chartUidSeq);
    const html =
      '<article class="card pick">' +
        '<div class="pick-head">' +
          '<div class="pick-id"><span class="pick-ticker">' + esc(p.ticker) + '</span>' +
            '<span class="pick-name">' + esc(p.name) + '</span></div>' +
          (p.horizon ? '<span class="chip horizon-chip">' + esc(p.horizon) + '</span>' : '') +
        '</div>' +
        meterHTML(p) +
        pickDetailHTML(p, uid, { flat: false, row: lbRowFor(p.ticker) }) +
      '</article>';
    const node = el(html);
    // 走势图交互(chip 切换 + 指针悬停)在此挂载;任何异常不影响整卡渲染
    const block = node.querySelector('.chart-block');
    const md = p.market_data;
    if (block && md) { try { wireChart(block, md); } catch (e) { /* 忽略图表挂载错误 */ } }
    return node;
  }

  /* ==================== 全市场排行榜(数据加载) ==================== */

  // 市场卡独立取 2 分钟缓存的最新延迟快照；失败不影响简报，自动退回落盘快照。
  async function loadMarketOverview() {
    try {
      const mo = await getJSON('/api/market');
      liveMarketOverview = (mo && Array.isArray(mo.indices) && mo.indices.length) ? mo : null;
    } catch (e) {
      liveMarketOverview = null;
    }
    if (currentBrief && viewMode === 'brief' && latestDate && currentBrief.date === latestDate) {
      render(currentBrief);
    }
  }

  // v3.2:方向与持仓风险独立加载,失败就地显示缺失态,不弹错。
  function wireReviewPacks(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.slice.call(root.querySelectorAll('details.review-pack')).forEach(function (det) {
      if (det.getAttribute('data-wired') === '1') return;
      det.setAttribute('data-wired', '1');
      det.addEventListener('toggle', function () {
        if (!det.open || det.getAttribute('data-ready') === '1' || det.getAttribute('data-loading') === '1') return;
        const ticker = det.getAttribute('data-ticker') || '';
        const body = det.querySelector('.sec-body');
        det.setAttribute('data-loading', '1');
        getJSON('/api/review-pack?ticker=' + encodeURIComponent(ticker)).then(function (pack) {
          det.innerHTML = '<summary>复核清单</summary>' + reviewPackHTML(pack);
          det.setAttribute('data-ready', '1');
          det.removeAttribute('data-loading');
        }).catch(function () {
          det.removeAttribute('data-loading');
          if (body) body.textContent = '复核包暂时读不出来，请稍后再试。持仓与论点原文不受影响。';
        });
      });
    });
  }

  async function loadV32Cards() {
    const box = document.getElementById('v32-cards');
    if (!box) return;

    const actionNode = document.getElementById('v32-actions-card');
    try {
      const action = await getJSON('/api/actions');
      if (actionNode) actionNode.outerHTML = actionCenterHTML(action);
    } catch (e) {
      if (actionNode) actionNode.outerHTML = actionCenterHTML(null);
    }

    const regimeNode = document.getElementById('v32-regime-card');
    try {
      const regime = await getJSON('/api/regime');
      if (regimeNode) regimeNode.outerHTML = regimeCardHTML(regime);
      try {
        const fwd = await getJSON('/api/regime-forward');
        const slot = document.getElementById('v32-fwd');
        const html = forwardTableHTML(fwd);
        if (slot && html) slot.outerHTML = html;
        else if (slot) slot.remove();
      } catch (e2) {
        const slot = document.getElementById('v32-fwd');
        if (slot) slot.remove();
      }
    } catch (e) {
      const fb = (typeof currentBrief !== 'undefined' && currentBrief && currentBrief.market_regime)
        ? currentBrief.market_regime : null;
      if (regimeNode) regimeNode.outerHTML = regimeCardHTML(fb);
      try {
        const fwd = await getJSON('/api/regime-forward');
        const slot = document.getElementById('v32-fwd');
        const html = forwardTableHTML(fwd);
        if (slot && html) slot.outerHTML = html;
        else if (slot) slot.remove();
      } catch (e2) {
        const slot = document.getElementById('v32-fwd');
        if (slot) slot.remove();
      }
    }

    const riskNode = document.getElementById('v32-risk-card');
    try {
      const risk = await getJSON('/api/position-risk');
      if (riskNode) riskNode.outerHTML = positionRiskCardHTML(risk);
      wireReviewPacks(document);
    } catch (e) {
      const fb = (typeof currentBrief !== 'undefined' && currentBrief && currentBrief.position_risk)
        ? currentBrief.position_risk : null;
      if (riskNode) riskNode.outerHTML = positionRiskCardHTML(fb);
    }
  }

  async function loadAudit() {
    try {
      auditData = await getJSON('/api/audit/latest');
    } catch (e) { auditData = null; return; }
    if (!auditData || typeof auditData !== 'object' || !auditData.date) auditData = null;
  }

  async function loadPerfHistory() {
    try {
      const h = await getJSON('/api/performance-history');
      perfHistory = Array.isArray(h) ? h : null;
    } catch (e) { perfHistory = null; }
  }

  async function loadLeaderboard() {
    try {
      leaderboardData = await getJSON('/api/leaderboard/latest');
    } catch (e) {
      leaderboardData = null;
      leaderboardReady = true;
      if (viewMode === 'brief' && currentBrief) {
        render(currentBrief);
        syncCalSelection();
      }
      return;
    }
    if (!leaderboardData || typeof leaderboardData !== 'object' || !Array.isArray(leaderboardData.rows)) {
      leaderboardData = null;
      leaderboardReady = true;
      if (viewMode === 'brief' && currentBrief) {
        render(currentBrief);
        syncCalSelection();
      }
      return;
    }
    leaderboardReady = true;
    if (viewMode === 'brief' && currentBrief) {
      render(currentBrief);
      syncCalSelection();
    }
  }

  /* ==================== 走势图交互挂载 ==================== */

  function getStoredChartRange() {
    let v = null;
    try { v = localStorage.getItem(CHART_RANGE_KEY); } catch (e) { v = null; }
    return v === '1y' ? '1y' : '1m';
  }

  // 给已插入 DOM 的 .chart-block 挂载:芯片切换、pointer 悬停十字线/浮层、尺寸自适应重绘
  function wireChart(block, md) {
    const plot = block.querySelector('.chart-plot');
    const tip = block.querySelector('.chart-tip');
    const chips = Array.prototype.slice.call(block.querySelectorAll('.chart-chip'));
    const uid = block.getAttribute('data-uid') || 'c';
    const has1m = Array.isArray(md.series1m) && md.series1m.length;
    const has1y = Array.isArray(md.series1y) && md.series1y.length;
    let range = getStoredChartRange();
    let layout = null;
    let lastW = 0;

    function plotW() { return Math.max(200, Math.round(plot.clientWidth || 320)); }

    function syncChips() {
      chips.forEach(function (c) {
        const on = c.getAttribute('data-range') === range;
        c.classList.toggle('on', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    function draw() {
      const w = plotW();
      const useY = range === '1y' && has1y;
      const series = useY ? md.series1y : (has1m ? md.series1m : (has1y ? md.series1y : []));
      const opts = { width: w, height: 120, showLow: useY, lowValue: md.low52w, uid: uid };
      layout = computeChartLayout(series, opts);
      lastW = w;
      const svgEl = el(buildChartSVG(series, opts));
      const old = plot.querySelector('svg');
      if (old) plot.replaceChild(svgEl, old);
      else plot.insertBefore(svgEl, tip);
      hideHover();
    }

    function hideHover() {
      tip.hidden = true;
      const svg = plot.querySelector('svg');
      if (!svg) return;
      const c = svg.querySelector('.sa-cross'); if (c) c.setAttribute('visibility', 'hidden');
      const h = svg.querySelector('.sa-hover'); if (h) h.setAttribute('visibility', 'hidden');
    }

    function onMove(ev) {
      const svg = plot.querySelector('svg');
      if (!svg || !layout || !layout.points.length) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scale = layout.W / rect.width;                 // viewBox 单位 / CSS 像素
      const vx = (ev.clientX - rect.left) * scale;         // 指针 → viewBox x
      let best = layout.points[0], bd = Infinity;
      for (let i = 0; i < layout.points.length; i++) {
        const dd = Math.abs(layout.points[i].x - vx);
        if (dd < bd) { bd = dd; best = layout.points[i]; }
      }
      const cross = svg.querySelector('.sa-cross');
      const hov = svg.querySelector('.sa-hover');
      if (cross) { cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x); cross.removeAttribute('visibility'); }
      if (hov) { hov.setAttribute('cx', best.x); hov.setAttribute('cy', best.y); hov.removeAttribute('visibility'); }
      tip.innerHTML = '<span class="chart-tip-d">' + esc(best.d) + '</span>' +
        '<span class="chart-tip-c">' + esc(money(best.c, 2)) + '</span>';
      tip.hidden = false;
      const cssX = best.x / scale;                         // viewBox x → plot 内 CSS 像素
      const tw = tip.offsetWidth || 0;
      let leftPx = cssX - tw / 2;
      const maxLeft = rect.width - tw - 2;
      if (leftPx < 2) leftPx = 2;
      if (maxLeft >= 2 && leftPx > maxLeft) leftPx = maxLeft;
      tip.style.left = leftPx + 'px';
    }

    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        const r = c.getAttribute('data-range');
        if (r !== '1m' && r !== '1y') return;
        range = r;
        try { localStorage.setItem(CHART_RANGE_KEY, range); } catch (e) { /* 忽略存储异常 */ }
        syncChips();
        draw();
      });
    });
    plot.addEventListener('pointermove', onMove);
    plot.addEventListener('pointerleave', hideHover);
    plot.addEventListener('pointercancel', hideHover);

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(function () { if (Math.abs(plotW() - lastW) >= 4) draw(); });
      ro.observe(plot);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', function () { if (Math.abs(plotW() - lastW) >= 4) draw(); });
    }

    syncChips();
    draw();
  }

  function renderTrail(brief) {
    const rt = brief.research_trail;
    if (!rt || !rt.stages) return null;
    const st = rt.stages;
    const parts = [];
    if (!aiRanInBrief(brief)) parts.push('本场 AI 未运行,无新结论');
    if (aiRanInBrief(brief)) {
      // 以实际跑过的 AI 为准,不拿 meta.model 冒充(GPT 回退的场次它仍写 opus)
      const ml = researchModelLabel(brief.meta);
      if (ml) parts.push(ml);
    }
    if (st.scan) parts.push('扫了一遍 ' + (st.scan.numTurns != null ? st.scan.numTurns + ' 轮' : ''));
    if (st.deepdive) parts.push('深入研究 ' + Object.keys(st.deepdive).length + ' 只');
    if (st.skeptic) parts.push('挑毛病的 AI 复查过');
    const usage = (brief.meta && (brief.meta.codex_usage_today || brief.meta.codex_usage)) || rt.codex_usage;
    if (usage && Number(usage.total_tokens) > 0) {
      const scope = brief.meta && brief.meta.codex_usage_today ? '今日累计' : '本场';
      parts.push('Codex ' + scope + ' ' + Number(usage.total_tokens).toLocaleString('en-US') + ' tokens' +
        '（输入 ' + Number(usage.input_tokens || 0).toLocaleString('en-US') +
        '，输出 ' + Number(usage.output_tokens || 0).toLocaleString('en-US') + '）');
    }
    // 免费 AI 用量与 Codex 分开显示(2026-09-25 起主用免费 AI,旧 Codex 行保留给历史简报)。
    const ocUsage = (brief.meta && (brief.meta.opencode_usage_today || brief.meta.opencode_usage)) || rt.opencode_usage;
    if (ocUsage && Number(ocUsage.total_tokens) > 0) {
      const scope = brief.meta && brief.meta.opencode_usage_today ? '今日累计' : '本场';
      parts.push('免费 AI ' + scope + ' ' + Number(ocUsage.total_tokens).toLocaleString('en-US') + ' tokens' +
        '（输入 ' + Number(ocUsage.input_tokens || 0).toLocaleString('en-US') +
        '，输出 ' + Number(ocUsage.output_tokens || 0).toLocaleString('en-US') + '）');
    }
    // 总耗时 = 各阶段 ms 之和(mock 为占位小值,真实运行为几十分钟)
    let ms = (st.scan && st.scan.ms) || 0;
    Object.keys(st.deepdive || {}).forEach((t) => { ms += (st.deepdive[t] && st.deepdive[t].ms) || 0; });
    ms += (st.skeptic && st.skeptic.ms) || 0;
    if (ms > 60000) parts.push('共 ' + Math.round(ms / 60000) + ' 分钟');
    const dir = rt.log_dir ? ' · 日志 ' + rt.log_dir : '';
    return el('<p class="trail">研究轨迹:' + esc(parts.join(' · ')) + esc(dir) + '</p>');
  }

  /* ==================== 简报加载 ==================== */

  async function loadBrief(date, session) {
    briefRegion.innerHTML = '<section class="card empty"><p class="empty-text">加载中…</p></section>';
    try {
      let brief;
      if (date && DATE_RE.test(date)) {
        brief = await getJSON('/api/briefs/' + date + (session ? '?session=' + encodeURIComponent(session) : ''));
      } else {
        brief = await getJSON('/api/latest');
        // /api/latest 即最新简报 → 记录为「回到今日」目标
        if (brief && brief.date) {
          latestDate = brief.date;
          saveLatestBriefCache(brief);
        }
      }
      selectedDate = brief.date || date || null;
      currentBrief = brief;
      viewMode = 'brief';
      if (calCard) calCard.hidden = !calHasContent; // 回到主页恢复日历
      render(brief);
      syncCalSelection();
    } catch (e) {
      if (e.status === 404) {
        briefRegion.innerHTML =
          '<section class="card empty"><p class="empty-text">' +
          (date ? '该日期暂无简报。' : '尚无任何简报,等待每日收盘后自动生成。') +
          '</p></section>';
      } else {
        const saved = !date ? loadLatestBriefCache() : null;
        if (saved && saved.brief) {
          const cachedBrief = Object.assign({}, saved.brief, { __fromLastSuccessfulCache: true });
          selectedDate = cachedBrief.date || null;
          currentBrief = cachedBrief;
          viewMode = 'brief';
          render(cachedBrief);
          syncCalSelection();
        } else {
          briefRegion.innerHTML =
            '<section class="card empty"><p class="empty-text">暂时无法连接数据服务。请检查网络后点「今日」重试。</p></section>';
        }
      }
    }
  }

  /* ==================== 月度回顾 ==================== */

  // boot 时并发拉取;404 或任何异常都完全无痕(不渲染入口)
  async function loadRetro() {
    try {
      retroData = await getJSON('/api/retro');
    } catch (e) {
      retroData = null;
      return;
    }
    if (!retroData || typeof retroData !== 'object') { retroData = null; return; }
    refreshBottomNav(); // retro 数据到位 → 底部菜单补「回顾」tab(入口卡已废弃,主页不再插卡)
  }

  // 在日历卡之后插入「月度回顾」入口卡(整卡可点)
  function insertRetroEntry() {
    if (!retroData || !calCard) return;
    const old = document.getElementById('retroEntry');
    if (old) old.remove();
    const period = retroData.period || {};
    const start = period.start || '';
    const end = period.end || '';
    const summary = String(retroData.summary == null ? '' : retroData.summary);
    const snippet = summary.length > 60 ? summary.slice(0, 60) + '…' : summary;
    const card = el(
      '<section class="card retro-entry" id="retroEntry" role="button" tabindex="0" aria-label="查看月度回顾">' +
        '<div class="retro-entry-head">' +
          '<span class="retro-entry-title">📅 月度回顾</span>' +
          '<span class="retro-entry-period">' + esc(start) + ' ~ ' + esc(end) + '</span>' +
        '</div>' +
        (snippet ? '<p class="retro-entry-summary">' + esc(snippet) + '</p>' : '') +
      '</section>'
    );
    const go = () => gotoView('retro');
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    calCard.insertAdjacentElement('afterend', card);
  }

  // 渲染回顾视图(独立视图,不走合并版 render()):返回链接 + 头(回顾 chip) + 市场概览 + 逐条 pick 卡(复用 renderPick)
  function showRetro() {
    if (!retroData) return;
    viewMode = 'retro';
    if (calCard) calCard.hidden = true; // 回顾页不显示日历
    const period = retroData.period || {};
    const start = period.start || '';
    const end = period.end || '';
    const items = Array.isArray(retroData.items) ? retroData.items : [];
    briefRegion.innerHTML = '';
    briefRegion.appendChild(el(
      '<div class="brief-head"><span class="brief-date">' + esc('月度回顾 ' + start + ' ~ ' + end) +
      '</span><span class="chip retro-badge">回顾</span></div>'
    ));
    if (retroData.summary) {
      briefRegion.appendChild(el(
        '<section class="card market"><div class="block-title">市场概览</div>' +
        '<p class="sec-body">' + esc(retroData.summary) + '</p></section>'
      ));
    }
    items.forEach(function (p) { if (p && typeof p === 'object') briefRegion.appendChild(renderPick(p)); });
    window.scrollTo(0, 0);
  }

  /* ==================== 历史成绩单 ==================== */

  // boot 时并发拉取。手机慢网下用户可能在大响应回来前点「记录」；
  // 复用同一个 Promise，不能把记录 tab 误导向简报请求。
  function loadPerformance() {
    if (perfData) return Promise.resolve(true);
    if (perfLoadPromise) return perfLoadPromise;
    perfLoadPromise = getJSON('/api/performance').then(function (data) {
      perfData = (data && typeof data === 'object') ? data : null;
      if (!perfData) return false;
      const picks = Array.isArray(perfData.picks) ? perfData.picks : [];
      const review = perfData.review || {};
      const hasSummary = review.summary && String(review.summary).trim() !== '';
      return !!(picks.length || hasSummary);
    }).catch(function () {
      perfData = null;
      return false;
    }).then(function (loaded) {
      perfLoadPromise = null;
      return loaded;
    });
    return perfLoadPromise;
  }

  // 在月度回顾入口卡(若无则日历卡)之后插入「历史成绩单」入口卡(整卡可点)
  function insertPerfEntry() {
    if (!perfData || !calCard) return;
    const old = document.getElementById('perfEntry');
    if (old) old.remove();
    const card = el(perfEntryHTML(perfData));
    const go = () => gotoView('perf');
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    const anchor = document.getElementById('retroEntry') || calCard;
    anchor.insertAdjacentElement('afterend', card);
  }

  // 渲染成绩单视图:返回链接 + 头 + 诚实基调 + 摘要 stat 行 + 复盘卡 + 已追踪推荐
  function showPerformance() {
    if (!perfData) return;
    viewMode = 'perf';
    if (calCard) calCard.hidden = true; // 成绩单页不显示日历
    briefRegion.innerHTML = '';
    briefRegion.appendChild(el(
      '<div class="brief-head"><span class="brief-date">历史成绩单</span><span class="chip perf-badge">成绩单</span></div>'
    ));
    briefRegion.appendChild(el('<p class="perf-honest">本页如实记录 AI 判断的对错,不回避失误。</p>'));
    briefRegion.appendChild(el(perfSummaryHTML(perfData)));
    // v3.2 分层验证:异步取 /api/accuracy(取不到就不显示这张卡,不编数字)
    try {
      var accSlot = el('<div id="v32-acc-slot"></div>');
      briefRegion.appendChild(accSlot);
      getJSON('/api/accuracy').then(function (acc) {
        var html = v32AccuracyHTML(acc);
        if (html) accSlot.outerHTML = html;
        else accSlot.remove();
      }).catch(function () { accSlot.remove(); });
    } catch (e) { /* 分层验证失败不影响成绩单主体 */ }
    briefRegion.appendChild(el(perfTrendHTML(perfHistory)));
    // 审计(每 3 天,评分标准自检)与成绩复盘同属「系统自省」,合并在本页
    if (auditData) {
      const ac = auditCardHTML(auditData);
      if (ac) briefRegion.appendChild(el(ac));
    }
    const reviewHTML = perfReviewHTML(perfData.review, perfData.picks, perfData.meta);
    if (reviewHTML) briefRegion.appendChild(el(reviewHTML));
    // 「已追踪推荐」全量列表已移除:与按日分组的复盘重复且无判断结论(perfPicksHTML 保留备用)
    window.scrollTo(0, 0);
  }

  function showPerformanceLoading() {
    viewMode = 'perf';
    if (calCard) calCard.hidden = true;
    briefRegion.innerHTML = '<section class="card empty"><p class="empty-text">正在读取历史记录…</p></section>';
  }

  function showPerformanceUnavailable() {
    viewMode = 'perf';
    if (calCard) calCard.hidden = true;
    briefRegion.innerHTML = '<section class="card empty"><p class="empty-text">历史记录暂时读不出来。请检查网络后再点一次「记录」。</p></section>';
  }

  // 算法说明页(methodHTML/methodBandRow/methodStep)已移到上方纯函数区,便于 node 下自测

  function showMethod() {
    viewMode = 'method';
    if (calCard) calCard.hidden = true; // 说明页不显示日历
    briefRegion.innerHTML = '';
    briefRegion.appendChild(el(
      '<div class="brief-head"><span class="brief-date">方法</span>' +
      '<span class="chip perf-badge">说明</span></div>'
    ));
    briefRegion.appendChild(el('<div>' + methodHTML() + '</div>'));
    window.scrollTo(0, 0);
  }

  /* ==================== 页面导航:底部菜单 + 转场动画 + 边缘滑动返回 ==================== */

  const VIEW_ORDER = { brief: 0, perf: 1, method: 2, retro: 3 };

  function renderView(mode) {
    if (mode === 'perf') {
      if (perfData) showPerformance();
      else {
        showPerformanceLoading();
        loadPerformance().then(function (loaded) {
          if (viewMode !== 'perf') return;
          if (loaded && perfData) showPerformance();
          else showPerformanceUnavailable();
        });
      }
    } else if (mode === 'method') showMethod();
    else if (mode === 'retro' && retroData) showRetro();
    else loadBrief(selectedDate);
  }

  // 转场:新视图按方向滑入(纯 CSS 动画;prefers-reduced-motion 时 CSS 侧自动关闭)
  function playEnterAnim(dir) {
    briefRegion.classList.remove('view-enter-right', 'view-enter-left');
    void briefRegion.offsetWidth; // 强制 reflow,重复切换也能重新触发动画
    briefRegion.classList.add(dir === 'left' ? 'view-enter-left' : 'view-enter-right');
  }

  function gotoView(mode, opts) {
    const o = opts || {};
    if (!VIEW_ORDER.hasOwnProperty(mode)) mode = 'brief';
    const dir = (VIEW_ORDER[mode] || 0) >= (VIEW_ORDER[viewMode] || 0) ? 'right' : 'left';
    // 非主页视图入历史栈:Android 返回键 / 浏览器后退 = 返回上个页面
    if (!o.noPush && mode !== viewMode && mode !== 'brief') {
      try { history.pushState({ v: mode }, '', '#' + mode); } catch (e) { /* 忽略 */ }
    }
    renderView(mode);
    playEnterAnim(dir);
    updateNavActive(mode);
  }

  function goBack() {
    if (history.state && history.state.v) history.back();
    else gotoView('brief', { noPush: true });
  }

  window.addEventListener('popstate', function (e) {
    const v = e.state && e.state.v;
    gotoView(v === 'perf' || v === 'method' || v === 'retro' ? v : 'brief', { noPush: true });
  });

  // 底部菜单:今日 / 成绩单(有数据才可达)/ 回顾(有数据才出现);数据到位后可重建刷新
  function updateNavActive(mode) {
    const nav = document.getElementById('bottomNav');
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('.bn-item'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === mode);
    });
  }

  function refreshBottomNav() {
    const old = document.getElementById('bottomNav');
    if (old) old.remove();
    const items = [
      { v: 'brief', icon: '今', label: '今日' },
      { v: 'perf', icon: '记', label: '记录' },
      { v: 'method', icon: '法', label: '方法' },
    ]; // 月度回顾 tab 已按用户要求移除(showRetro 代码保留,暂无入口)
    const nav = el('<nav id="bottomNav" class="bottom-nav" aria-label="页面导航">' + items.map(function (i) {
      return '<button class="bn-item' + (i.v === viewMode ? ' on' : '') + '" type="button" data-view="' + i.v + '">' +
        '<span class="bn-icon" aria-hidden="true">' + i.icon + '</span><span class="bn-label">' + esc(i.label) + '</span></button>';
    }).join('') + '</nav>');
    nav.addEventListener('click', function (e) {
      const btn = e.target.closest('.bn-item');
      if (btn) gotoView(btn.getAttribute('data-view'));
    });
    document.body.appendChild(nav);
    document.body.classList.add('has-bottom-nav');
  }

  // 左缘滑动返回(iOS 式):非主页视图从屏幕左缘 32px 内起手向右拖,手指跟随,超过阈值松手即返回
  (function wireSwipeBack() {
    let sx = 0, sy = 0, tracking = false, active = false;
    function reset(ms) {
      setTimeout(function () {
        briefRegion.style.transition = ''; briefRegion.style.transform = ''; briefRegion.style.opacity = '';
      }, ms);
    }
    document.addEventListener('touchstart', function (e) {
      if (viewMode === 'brief' || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > 32) return;
      sx = t.clientX; sy = t.clientY; tracking = true; active = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!active) {
        if (dx < 12 || Math.abs(dx) < Math.abs(dy) * 1.2) { if (Math.abs(dy) > 16) tracking = false; return; }
        active = true;
        briefRegion.style.transition = 'none';
      }
      briefRegion.style.transform = 'translateX(' + Math.max(0, dx) + 'px)';
      briefRegion.style.opacity = String(Math.max(0.4, 1 - dx / (window.innerWidth * 1.5)));
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      if (!active) return;
      const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : sx) - sx;
      briefRegion.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
      if (dx > 90) {
        briefRegion.style.transform = 'translateX(100%)';
        setTimeout(goBack, 150);
        reset(170);
      } else {
        briefRegion.style.transform = 'translateX(0)';
        reset(200);
      }
    }, { passive: true });
  })();

  /* ==================== 月历卡 ==================== */

  function idxByDate() {
    const m = Object.create(null);
    indexData.forEach((it) => { if (it && it.date) m[it.date] = it; });
    return m;
  }

  // markFor / calendarAiRan 定义在上面的纯函数区(可被测试锁住),这里直接用

  async function loadIndexAndCal() {
    try {
      indexData = await getJSON('/api/briefs');
    } catch (e) {
      indexData = [];
    }
    if (!Array.isArray(indexData)) indexData = [];
    // 最新简报日期(索引最大合法日期)——「回到今日」目标;若已由 /api/latest 设过则以较大者为准
    const idxLatest = latestIndexDate();
    if (idxLatest && (!latestDate || idxLatest > latestDate)) latestDate = idxLatest;
    const anchor = (selectedDate && DATE_RE.test(selectedDate)) ? selectedDate : laToday();
    const parts = anchor.split('-');
    calYear = Number(parts[0]);
    calMonth = Number(parts[1]) - 1;
    calHasContent = true;
    calCard.hidden = (viewMode !== 'brief'); // 成绩单/回顾页不显示日历
    renderCalendar();
    // 深链 ?date 首屏可能早于索引加载完成 → 此时补判「回到今日」链接
    applyBackToToday();
  }

  // 索引里最大合法日期(索引通常已降序,仍防御性取最大)
  function latestIndexDate() {
    let best = null;
    indexData.forEach(function (it) {
      if (it && it.date && DATE_RE.test(it.date) && (!best || it.date > best)) best = it.date;
    });
    return best;
  }

  // 新用户默认收起月历,把第一屏留给「今日重点」;明确展开过的用户继续尊重其选择。
  function calendarCollapsed() {
    const saved = localStorage.getItem(CAL_COLLAPSE_KEY);
    return saved == null ? true : saved === '1';
  }

  function renderCalendar() {
    const collapsed = calendarCollapsed();
    const map = idxByDate();
    const today = laToday();

    const first = new Date(Date.UTC(calYear, calMonth, 1));
    const startDow = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(calYear, calMonth + 1, 0)).getUTCDate();
    const monthLabel = calYear + ' 年 ' + (calMonth + 1) + ' 月';

    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell blank"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const it = map[ds];
      const mk = markFor(it);
      const classes = ['cal-cell'];
      if (!it) classes.push('none');
      if (ds === today) classes.push('today');
      if (ds === selectedDate) classes.push('sel');
      const clickable = it ? ' data-date="' + ds + '" role="button" tabindex="0"' : '';
      cells += '<div class="' + classes.join(' ') + '"' + clickable + '>' +
        '<span class="cal-num">' + d + '</span>' +
        '<span class="mark ' + mk.cls + '"' + (mk.cls === 'mark-fail' ? '>×' : '>') + '</span>' +
        '</div>';
    }

    const dowRow = DOW.map((n) => '<div class="cal-dow">' + n + '</div>').join('');
    const selInfo = selInfoText();

    calCard.className = 'card cal-card' + (collapsed ? ' collapsed' : '');
    calCard.innerHTML =
      '<div class="cal-head">' +
        '<div class="cal-head-left">' +
          '<span class="cal-month">' + monthLabel + '</span>' +
          '<span class="cal-selinfo">' + esc(selInfo) + '</span>' +
        '</div>' +
        '<div class="cal-head-right">' +
          '<button class="cal-nav" data-nav="-1" type="button" aria-label="上一月">‹</button>' +
          '<button class="cal-nav" data-nav="1" type="button" aria-label="下一月">›</button>' +
          '<button class="cal-collapse" data-collapse type="button" aria-label="折叠">▾</button>' +
        '</div>' +
      '</div>' +
      '<div class="cal-body">' +
        '<div class="cal-grid">' + dowRow + cells + '</div>' +
        '<div class="cal-legend">' +
          '<span class="legend-item"><span class="mark mark-pick"></span><span class="legend-text">有推荐</span></span>' +
          '<span class="legend-item"><span class="mark mark-nopick"></span><span class="legend-text">已分析·无合格标的</span></span>' +
          '<span class="legend-item"><span class="mark mark-static"></span><span class="legend-text">AI 未运行</span></span>' +
          '<span class="legend-item"><span class="mark mark-fail">×</span><span class="legend-text">运行失败</span></span>' +
        '</div>' +
      '</div>';

    wireCalendar();
  }

  function selInfoText() {
    if (!selectedDate) return '';
    const it = idxByDate()[selectedDate];
    if (!it) return selectedDate;
    const mk = markFor(it);
    const extra = mk.cls === 'mark-pick' ? '(' + it.numPicks + ' 条)' : '';
    return selectedDate + ' · ' + mk.label + extra;
  }

  function wireCalendar() {
    const head = calCard.querySelector('.cal-head-left');
    if (head) head.addEventListener('click', toggleCollapse);
    const collapseBtn = calCard.querySelector('[data-collapse]');
    if (collapseBtn) collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(); });
    calCard.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        stepMonth(Number(b.getAttribute('data-nav')));
      });
    });
    calCard.querySelectorAll('[data-date]').forEach((c) => {
      const go = () => selectDate(c.getAttribute('data-date'));
      c.addEventListener('click', go);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function toggleCollapse() {
    const now = calendarCollapsed();
    localStorage.setItem(CAL_COLLAPSE_KEY, now ? '0' : '1');
    calCard.classList.toggle('collapsed', !now);
  }

  function stepMonth(delta) {
    calMonth += delta;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    else if (calMonth > 11) { calMonth = 0; calYear += 1; }
    renderCalendar();
  }

  function selectDate(ds) {
    if (!ds || !DATE_RE.test(ds)) return;
    const u = new URL(window.location.href);
    u.searchParams.set('date', ds);
    window.history.replaceState({}, '', u);
    loadBrief(ds);
  }

  // 简报加载后回填月历选中态(切月时也保持)
  function syncCalSelection() {
    if (!calCard || calCard.hidden) return;
    if (selectedDate && DATE_RE.test(selectedDate)) {
      const p = selectedDate.split('-');
      calYear = Number(p[0]);
      calMonth = Number(p[1]) - 1;
    }
    renderCalendar();
  }

  /* ==================== Web Push ==================== */

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // 铃铛(可用)与斜杠铃铛(不可用/被拒),线条风格与分享图标一致
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  const BELL_ON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0" fill="none" stroke-width="1.8"/></svg>';
  const BELL_OFF_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8c0 4.5 1.2 7 2 8"/><path d="M17 17H3s3-2 3-9c0-.7.1-1.4.3-2"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M2 2l20 20"/></svg>';

  function setPushState(on, disabled, text) {
    if (!pushBtn) return;
    pushBtn.hidden = false;
    pushBtn.disabled = !!disabled;
    pushBtn.dataset.state = on ? 'on' : 'off';
    pushBtn.innerHTML = disabled ? BELL_OFF_SVG : (on ? BELL_ON_SVG : BELL_SVG);
    // 状态文字进 tooltip / 无障碍标签,不再占顶栏空间
    pushBtn.title = text;
    pushBtn.setAttribute('aria-label', text);
  }

  async function refreshPushButton() {
    if (!pushBtn) return;
    if (!pushSupported) {
      // iOS Safari 只有安装到主屏(standalone)后才有 PushManager
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const standalone = window.navigator.standalone === true
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      setPushState(false, true, isIOS && !standalone ? '先添加到主屏幕' : '不支持推送');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushState(false, true, '推送被拒');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) setPushState(true, false, '已开启推送');
      else setPushState(false, false, '开启推送');
    } catch (e) {
      setPushState(false, false, '开启推送');
    }
  }

  async function onPushClick() {
    if (!pushSupported) return;
    pushBtn.disabled = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();

      if (existing) {
        // 退订:先本地取消,再通知后端移除
        const endpoint = existing.endpoint;
        await existing.unsubscribe();
        await fetch('/api/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
        toast('已关闭推送');
        await refreshPushButton();
        return;
      }

      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('未授予通知权限'); await refreshPushButton(); return; }

      const { publicKey } = await getJSON('/api/vapid-public-key');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }),
      });
      toast('已开启推送');
      await refreshPushButton();
    } catch (e) {
      toast('操作失败,请重试');
      await refreshPushButton();
    }
  }

  /* ==================== 分享 / 添加到主屏幕 ==================== */

  const SHARE_URL = location.origin + '/';
  const SHARE_TITLE = '美股晨析';
  const SHARE_TEXT = '简单、克制的美股长期研究：只看结论、理由和证据边界';

  function isStandalone() {
    return window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  // 返回当前平台的「添加到主屏幕」步骤(纯前端判断,无网络)
  function a2hsSteps() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      return [
        '用 <b>Safari</b> 打开本页(其他浏览器无法添加)',
        '点底部中间的<span class="k">分享 ↑</span>按钮',
        '下滑选择<span class="k">添加到主屏幕</span>',
        '点右上角<b>添加</b>,回到桌面即可像 App 一样打开',
      ];
    }
    return [
      '用 <b>Chrome</b> 打开本页',
      '点右上角<span class="k">⋮</span>菜单',
      '选择<span class="k">添加到主屏幕</span>或<span class="k">安装应用</span>',
      '确认后回到桌面即可像 App 一样打开',
    ];
  }

  // 组装可复制的纯文本:标题 + 链接 + 加主屏幕教程(去掉 HTML 标签)
  function shareMessage() {
    const steps = a2hsSteps()
      .map((s, i) => (i + 1) + '. ' + s.replace(/<[^>]+>/g, ''))
      .join('\n');
    return SHARE_TITLE + '\n' + SHARE_TEXT + '\n' + SHARE_URL
      + '\n\n【添加到主屏幕,像 App 一样用】\n' + steps;
  }

  function closeShareSheet() {
    const m = document.getElementById('shareSheet');
    if (!m) return;
    m.classList.remove('show');
    setTimeout(() => m.remove(), 200);
  }

  function openShareSheet() {
    if (document.getElementById('shareSheet')) return;
    const stepsHtml = isStandalone()
      ? '<p class="sheet-sub">已添加到主屏幕 ✓ 把链接发给朋友即可分享。</p>'
      : '<div class="sheet-steps"><h4>添加到主屏幕(像 App 一样用)</h4><ol>'
        + a2hsSteps().map(s => '<li>' + s + '</li>').join('') + '</ol></div>';
    const mask = el(
      '<div id="shareSheet" class="sheet-mask" role="dialog" aria-modal="true" aria-label="分享">'
      + '<div class="sheet">'
      + '<div class="sheet-head"><h3>分享 / 添加到主屏幕</h3>'
      + '<button class="sheet-close" type="button" aria-label="关闭">&times;</button></div>'
      + '<div class="sheet-copy"><input type="text" readonly value="' + SHARE_URL + '">'
      + '<button type="button" class="copyOnly">仅链接</button></div>'
      + '<div class="sheet-copy"><button type="button" class="copyAll" style="flex:1">复制链接 + 教程</button></div>'
      + (navigator.share ? '<div class="sheet-copy"><button type="button" class="nativeShare" style="flex:1">通过系统分享…</button></div>' : '')
      + stepsHtml
      + '</div></div>'
    );
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));

    mask.addEventListener('click', (e) => { if (e.target === mask) closeShareSheet(); });
    mask.querySelector('.sheet-close').addEventListener('click', closeShareSheet);
    async function copyText(text, okMsg) {
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(text);
        else { const i = mask.querySelector('input'); i.value = text; i.select(); document.execCommand('copy'); i.value = SHARE_URL; }
        toast(okMsg);
      } catch (e) { toast('复制失败,请手动选择'); }
    }
    mask.querySelector('.copyOnly').addEventListener('click', () => copyText(SHARE_URL, '链接已复制'));
    mask.querySelector('.copyAll').addEventListener('click', () => copyText(shareMessage(), '链接 + 教程已复制'));
    const ns = mask.querySelector('.nativeShare');
    if (ns) ns.addEventListener('click', async () => {
      try { await navigator.share({ title: SHARE_TITLE, text: shareMessage(), url: SHARE_URL }); }
      catch (e) { /* 用户取消或不支持,忽略 */ }
    });
  }

  function onShareClick() { openShareSheet(); }

  /* ==================== 启动 ==================== */

  function initialDate() {
    const p = new URLSearchParams(window.location.search).get('date');
    return p && DATE_RE.test(p) ? p : null;
  }

  function boot() {
    // SW 注册(推送与离线壳依赖它);失败不影响主流程
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(function (reg) { return reg.update(); })
        .catch(() => {});
    }

    if (pushBtn) {
      pushBtn.addEventListener('click', onPushClick);
      refreshPushButton();
    }
    if (shareBtn) shareBtn.addEventListener('click', onShareClick);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShareSheet(); });

    selectedDate = initialDate();
    loadBrief(selectedDate);
    loadIndexAndCal();
    loadRetro();
    loadPerformance();
    loadMarketOverview();
    loadLeaderboard();
    loadAudit();
    loadPerfHistory();
    refreshBottomNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ---- 前台自动检查更新:iOS PWA 切回前台不会重新加载页面,旧版一直跑在内存里。
   启动记住 /api/version,回前台(节流60s)+每30分钟比对;发现新版弹常驻「点此更新」条,
   点击就地刷新;不自动 reload,避免打断正在看的内容。 ---- */
(function () {
  // 2026-07-29 修回归:这个 IIFE 是独立的顶层立即执行块,绕过了上面那段
  // `if (typeof document === 'undefined') return;` 守卫,导致 require('public/app.js')
  // 在 Node 下直接抛 `document is not defined` —— 一次把 8 个前端测试文件全带红
  // (npm test 从 510/2 变成 804/11)。纯函数区必须能在无 DOM 环境被 require,
  // 所以顶层 IIFE 必须自带守卫。test/frontend-honesty.test.js 等都依赖这一点。
  if (typeof document === 'undefined' || typeof fetch !== 'function') return;
  let myBuild = null, lastCheck = 0;
  async function checkUpdate() {
    const now = Date.now(); if (now - lastCheck < 60000) return; lastCheck = now;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' }); if (!r.ok) return;
      const d = await r.json(); if (!d || !d.sha) return;
      if (myBuild === null) { myBuild = d.sha; return; }
      if (d.sha !== myBuild && !document.getElementById('updbar')) {
        const el = document.createElement('div'); el.id = 'updbar';
        el.textContent = '✨ 美股晨析有新版本,点此更新';
        el.addEventListener('click', () => location.reload());
        document.body.appendChild(el);
      }
    } catch (e) { /* 离线静默,回前台再试 */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
  setInterval(checkUpdate, 30 * 60 * 1000);
  checkUpdate();
})();
