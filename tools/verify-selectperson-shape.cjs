/**
 * 「选人类接口」的**真实响应结构**留档 + 回归测试。
 *
 * ══════════════ 这些是用户实测抓回来的（2026-10）══════════════
 *
 * 探测目标：为「加减分」和「点不中」找接口。
 *
 * ── 接口存在性（本机 + App 双向验证）──
 *   401 / 405 → 路径存在（401=GET 缺 token，405=要 POST/DELETE）
 *   400 + {"message":"未知参数错误"} → ★ 会话有效、无角色校验，只是缺参数
 *
 * ── `GET /apps/selectperson/getDetail` 的真实响应（用户实测）──
 *
 *   {
 *     "msg":"成功", "code":200,
 *     "score": 2,                    ← ★ 当前登录者的分数
 *     "students": [{
 *       "className":"2025软件2班",
 *       "interlocutionCount": 0,
 *       "remark":"",
 *       "score": 2,
 *       "selectPersonCount": 0,      ← ★★ 被选中次数
 *       "studentId":"2025404030323",
 *       "userId": 13959853,
 *       "userName":"刘浩然"
 *     }],
 *     "classroomId": 443969,
 *     "selectCount": 1,              ← 抽几个人
 *     "selectType": 0,               ← ★★★ 抽选方式（点不中的抓手）
 *     "id": 148394,                  ← 活动 id（= relationId）
 *     "title":"2026-10-12 11:17 选人",
 *     "status": 0,
 *     "draft": 0, "description":""
 *   }
 *
 * ══════════════ ⚠️ 这个测试的"宿主页面"已经被删了 ══════════════
 *
 * 用户原话（2026-10）：
 *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
 *
 * ⚠️ 原来上面这些结构是**靠接口测试器的模板**去触达、留档的
 *    （本文件第一版就是读 `src/screens/api-tester.tsx` 来断言）。
 *    页面删除后 `readFileSync` 会直接 ENOENT —— 但**留档不能跟着丢**：
 *      · 这些路径与结论现在由 `probeActivityApi.ts`（探测模块）和
 *        `signApi.ts`（点不中的正规流程）承担；
 *      · 所以下面的断言改成"**这两个文件里仍有留档**"。
 *
 * ══════════════ 当初那个未定的语义问题，现在已经定了 ══════════════
 *
 * 当时不确定 `students` 是 A（候选池）还是 B（本次已抽到的人），
 * 所以留了一句"**没确认之前不要贸然实现点不中**"。
 * 后来确认的结论：它就是**候选池**，把自己移出去 = 点不中
 * （用户实测：名单 10 人含自己 → 删掉后 9 人）。
 * 那句提醒现在留在 `signApi.ts` 里当留档 —— 本测试最后一块会钉住它。
 *
 * 用法: node tools/verify-selectperson-shape.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SIGN = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');
const PROBE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'probeActivityApi.ts'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('=== 1) ★★★ 宿主页面已删，但实测知识必须留在别处 ===');
{
  /**
   * ⚠️ 断言方向反过来了：原来是"模板里有 getDetail / randomChoosePerson"，
   *    现在是"页面不存在 + 这两条路径的留档仍在（在探测模块或 signApi 里）"。
   */
  t('★★★ 接口测试器页面已删除（连同它的模板）',
    !fs.existsSync(path.join(ROOT, 'src', 'screens', 'api-tester.tsx')));
  t('★★ 全项目没有恢复它的入口', !/push\('\/api-tester'\)/.test(SIGN + PROBE));
  t('★★ getDetail 的留档仍在（实测 200 + 成功）', /\/apps\/selectperson\/getDetail/.test(PROBE) || /\/apps\/selectperson\/getDetail/.test(SIGN));
  t('★★ randomChoosePerson 的留档仍在', /\/apps\/selectperson\/randomChoosePerson/.test(PROBE));
  /**
   * ⚠️ `classscore/getDetail` **刻意不碰** ——
   *    它要的是**打分活动自己的 id**，拿选人活动的 id 去读会得到
   *    `{"message":"未知参数错误"}`（用户实测踩过）。
   *    这条断言原来写成"模板里不含它"，现在改成"两个留档文件里都不把它当路径用"。
   */
  t('★★★ classscore/getDetail 没被当成请求路径', !/classscore\/getDetail/.test(PROBE) && !/classscore\/getDetail/.test(SIGN));
  /** ★ 真 id 作默认值 —— 用户实测用的就是 148394，留档不许丢 */
  t('★ 实测活动 id 148394 仍有留档', PROBE.includes('148394') || SIGN.includes('148394'));
}

console.log('\n=== 2) ★★★ 确认过的接口路径都留在代码里 ===');
{
  /**
   * ⚠️ 这些路径是**实测确认**的（401/405/400 响应），不是猜的。
   *    留档是为了：以后要改回来时，不用再猜三轮。
   *    页面删掉后，留档的责任落在探测模块与 signApi 上。
   */
  for (const p of [
    'selectperson/giveMark',
    'selectperson/updateSelectRange',
    'selectperson/deleteSelectedPerson',
    'selectperson/saveSelectedPerson',
    'classscore/markByStudent',
  ]) {
    t(`★★ 留档 ${p}`, PROBE.includes(p) || SIGN.includes(p));
  }
  t('★★★ 都带 /apps 前缀（少了它全 404 —— 前三轮踩的坑）', /\/apps\/selectperson\/giveMark/.test(PROBE));
}

console.log('\n=== 3) ★★ 通用请求能力（问参数的工具链）===');
{
  /** ★ 这是**页面删了也必须留**的能力：探测与点不中都从它走 */
  t('★★ signApi 有 rawRequest', /async rawRequest\(input: \{/.test(SIGN));
  t('★★ 支持 POST/DELETE（写接口要它们）', /method\?: 'GET' \| 'POST' \| 'PUT' \| 'DELETE'/.test(SIGN));
  t('★ 注释记录了"为何要这个工具"（不想再猜第四轮）', /不想再猜第四轮/.test(SIGN));
}

console.log('\n=== 4) ★★★ 当初"未确认的语义"要留档，别让后人再猜一遍 ===');
{
  /**
   * ⚠️ 这是**防止未来（包括我自己）猜错方向**的关键：
   *    当年 `students` 到底是候选池还是已抽到的人没确认，
   *    猜错就会做出个"看着能跑、实际没用"的功能。
   *    ⚠️ 原来这两条断言挂在 api-tester.tsx 上（那个文件写了解释），
   *       页面删了 → 改成查**仍在的** `signApi.ts`：点不中的实现里
   *       把"候选池"和"复核也不能 100% 证明"这些结论写在了注释里。
   */
  t('★★ 注释保留了"候选池"这个语义结论', /候选池/.test(SIGN));
  t('★★ 注释诚实写明"列表里没我不能 100% 证明服务端已移出"', /不能 100% 证明/.test(SIGN));
  /** ★ selectType 是数字这件事必须留档（之前我以为是字符串枚举） */
  t('★★ 代码里按数字判 selectType（不是字符串枚举）', /typeof j\.selectType === 'number'/.test(SIGN));
  t('★★ 探测模块留了 selectType 相关的路径写法', /selectType/.test(PROBE));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
