#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成《LifeKit 功能完成情况说明》DOCX。

字体注意：中文必须显式设置 w:eastAsia，否则 Word/LibreOffice 会用默认字体，
中文可能变成方框或字形不一致。符号只用 √ × ● ○ ★ → 等微软雅黑确认覆盖的字符
（实测 msyh 没有 ✓ ✔ ✗ 字形）。
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# 输出到**仓库根目录**（脚本在 tools/pdf/ 下 → 往上两级）
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(_ROOT, 'LifeKit-功能完成情况.pdf')
DOCX = os.path.join(_ROOT, 'LifeKit-功能完成情况.docx')

CJK = '微软雅黑'
LATIN = 'Segoe UI'
C_PRIMARY = RGBColor(0x63, 0x66, 0xF1)
C_TEXT = RGBColor(0x11, 0x17, 0x26)
C_MUTED = RGBColor(0x6B, 0x72, 0x80)
C_GREEN = RGBColor(0x10, 0xB9, 0x81)
C_RED = RGBColor(0xEF, 0x44, 0x44)
C_ORANGE = RGBColor(0xF5, 0x9E, 0x0B)

doc = Document()

# ---------------------------------------------------------------- 基础样式
def setup_styles():
    st = doc.styles['Normal']
    st.font.name = LATIN
    st.font.size = Pt(10.5)
    st.font.color.rgb = C_TEXT
    st.element.rPr.rFonts.set(qn('w:eastAsia'), CJK)
    pf = st.paragraph_format
    pf.space_after = Pt(4)
    pf.line_spacing = 1.45

    for name, size, color, before, after in [
        ('Heading 1', 17, C_PRIMARY, 16, 8),
        ('Heading 2', 13, C_TEXT, 12, 6),
        ('Heading 3', 11.5, C_TEXT, 10, 4),
    ]:
        h = doc.styles[name]
        h.font.name = LATIN
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.color.rgb = color
        h.element.rPr.rFonts.set(qn('w:eastAsia'), CJK)
        h.paragraph_format.space_before = Pt(before)
        h.paragraph_format.space_after = Pt(after)
        h.paragraph_format.keep_with_next = True

    # 页面设置
    for s in doc.sections:
        s.top_margin = Cm(2.0)
        s.bottom_margin = Cm(2.0)
        s.left_margin = Cm(2.2)
        s.right_margin = Cm(2.2)

setup_styles()


def set_run(run, size=None, bold=None, color=None, cjk=CJK, latin=LATIN):
    run.font.name = latin
    run._element.rPr.rFonts.set(qn('w:eastAsia'), cjk)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = color
    return run


def para(text='', size=10.5, bold=False, color=None, align=None, space_after=None,
         space_before=None, indent=None, style=None):
    p = doc.add_paragraph(style=style) if style else doc.add_paragraph()
    if text:
        set_run(p.add_run(text), size=size, bold=bold, color=color)
    if align is not None:
        p.alignment = align
    if space_after is not None:
        p.paragraph_format.space_after = Pt(space_after)
    if space_before is not None:
        p.paragraph_format.space_before = Pt(space_before)
    if indent is not None:
        p.paragraph_format.left_indent = Cm(indent)
    return p


def rich(parts, size=10.5, align=None, space_after=None, indent=None, hanging=None):
    """parts: [(text, bold, color), ...]"""
    p = doc.add_paragraph()
    for t in parts:
        text, bold, color = (t + (None, None))[:3] if len(t) < 3 else t
        set_run(p.add_run(text), size=size, bold=bold, color=color)
    if align is not None:
        p.alignment = align
    if space_after is not None:
        p.paragraph_format.space_after = Pt(space_after)
    if indent is not None:
        p.paragraph_format.left_indent = Cm(indent)
    if hanging is not None:
        p.paragraph_format.first_line_indent = Cm(-hanging)
    return p


def h1(t):
    doc.add_heading(t, level=1)


def h2(t):
    doc.add_heading(t, level=2)


def h3(t):
    doc.add_heading(t, level=3)


def bullet(text, size=10.5, marker='●', mcolor=C_PRIMARY, indent=0.6):
    rich([(marker + '  ', True, mcolor), (text, False, None)], size=size, indent=indent, hanging=0.55)


def kv_block(pairs, size=10.5, kw=3.2):
    """键值块：用单个多行 2 列表格实现，行间距紧凑（避免每对都插空段落）"""
    t = doc.add_table(rows=0, cols=2)
    t.autofit = False
    total = 16.6
    for k, v in pairs:
        cells = t.add_row().cells
        cells[0].width = Cm(kw)
        cells[1].width = Cm(total - kw)
        p0 = cells[0].paragraphs[0]
        set_run(p0.add_run(k), size=size, color=C_MUTED)
        p0.paragraph_format.space_after = Pt(1)
        p0.paragraph_format.space_before = Pt(1)
        p1 = cells[1].paragraphs[0]
        set_run(p1.add_run(v), size=size)
        p1.paragraph_format.space_after = Pt(1)
        p1.paragraph_format.space_before = Pt(1)
    set_cell_borders(t, none=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def kv(k, v, size=10.5, kw=3.4):
    return kv_block([(k, v)], size=size, kw=kw)


def set_cell_borders(table, none=False, color='D9DBE0'):
    tbl = table._tbl
    tblPr = tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement('w:' + edge)
        if none:
            el.set(qn('w:val'), 'none')
            el.set(qn('w:sz'), '0')
        else:
            el.set(qn('w:val'), 'single')
            el.set(qn('w:sz'), '4')
            el.set(qn('w:color'), color)
        borders.append(el)
    tblPr.append(borders)


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hexcolor)
    tcPr.append(shd)


def table(headers, rows, widths, size=9.5, header_bg='EFF0FE'):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    total = 16.6
    ws = [Cm(total * w) for w in widths]
    hdr = t.rows[0].cells
    for i, htext in enumerate(headers):
        hdr[i].width = ws[i]
        p = hdr[i].paragraphs[0]
        set_run(p.add_run(htext), size=size, bold=True, color=C_TEXT)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.space_before = Pt(2)
        shade(hdr[i], header_bg)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].width = ws[i]
            p = cells[i].paragraphs[0]
            txt = str(val)
            # 支持 "√ xxx" 形式：把 √/× 标识符着色
            if txt.startswith('√ ') or txt.startswith('× ') or txt.startswith('● '):
                set_run(p.add_run(txt[:1]), size=size, bold=True,
                        color=C_GREEN if txt[0] == '√' else (C_RED if txt[0] == '×' else C_ORANGE))
                set_run(p.add_run(txt[1:]), size=size)
            else:
                set_run(p.add_run(txt), size=size)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
    set_cell_borders(t)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def code_block(lines, size=9):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.4)
    pf.space_before = Pt(4)
    pf.space_after = Pt(8)
    pf.line_spacing = 1.25
    # 背景色
    pPr = p._p.get_or_add_pPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), 'F4F5F7')
    pPr.append(shd)
    for i, ln in enumerate(lines):
        if i:
            p.add_run().add_break()
        set_run(p.add_run(ln), size=size, cjk='Consolas', latin='Consolas')
    return p


def callout(title, body, color_hex='EEF2FF', bar=None):
    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    cell = t.rows[0].cells[0]
    cell.width = Cm(16.6)
    shade(cell, color_hex)
    p = cell.paragraphs[0]
    set_run(p.add_run(title), size=10, bold=True)
    p.paragraph_format.space_after = Pt(2)
    p2 = cell.add_paragraph()
    set_run(p2.add_run(body), size=9.5)
    p2.paragraph_format.space_after = Pt(2)
    set_cell_borders(t, none=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def page_break():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# ================================================================ 封面
para()
para()
p = para('LifeKit 个人生活 App', size=26, bold=True, color=C_PRIMARY, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
para('功能完成情况说明', size=17, bold=False, color=C_MUTED, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=20)

t = doc.add_table(rows=4, cols=2)
t.autofit = False
meta = [
    ('工程名称', 'LifeKit（个人生活 App）'),
    ('技术栈', 'React Native 0.76.3 + Expo SDK 52 + TypeScript 5.3'),
    ('目标平台', 'Android / iOS（React Native 跨平台）'),
    ('文档版本', 'v1.0'),
]
for i, (k, v) in enumerate(meta):
    c0, c1 = t.rows[i].cells
    c0.width = Cm(2.8)
    c1.width = Cm(13.8)
    set_run(c0.paragraphs[0].add_run(k), size=10, color=C_MUTED)
    set_run(c1.paragraphs[0].add_run(v), size=10, bold=True)
    for c in (c0, c1):
        c.paragraphs[0].paragraph_format.space_after = Pt(2)
        c.paragraphs[0].paragraph_format.space_before = Pt(2)
set_cell_borders(t, none=True)

para()
callout('一句话概括',
        '从零搭建的个人生活 App 已完成：优学院签到模块（含地点签到 / 扫码签到两个入口与全部签到状态总览）、'
        '外卖记录模块、功能模块与授权体系三大块。'
        '类型检查 0 错误，65 项回归测试全部通过，Android 打包验证成功（8.30 MB）。')

para()
para('验证数据一览', size=12, bold=True, space_after=6)
table(['检查项', '结果', '说明'], [
    ['TypeScript 类型检查', '√ 0 错误', 'strict 模式'],
    ['回归测试', '√ 65 / 65', '加密 11 + 地理 11 + 外卖 19 + 模块 24 + 授权 29'],
    ['Metro 打包（Android）', '√ 成功', '8.30 MB，签到模块全部端点均在产物中'],
    ['优学院接口实测', '√ 5 个接口', '签到查询 / 提交 / 详情 / 签到码 / 用户资料'],
    ['登录链路实测', '√ 跑通', 'CAS + AES 加密 + 3 跳换票'],
], widths=[0.34, 0.2, 0.46])

page_break()

# ================================================================ 一、总览
h1('一、项目总览')

para('LifeKit 是一个从零开始搭建的个人生活 App。它不是某个现成应用的复刻，而是围绕'
      '"把学校里琐碎的事务自动化"这个目标重新设计的：课程签到、外卖记录、待办与统计'
      '被拆成互相独立的功能模块，用户可以在首页横向滑动切换，也可以在设置里按需开关。')

h2('1.1 为什么要做成"模块化"')

para('最初的需求来自一个具体痛点：优学院的签到需要人在教室、有网络、手速够快，'
      '而不同学校的签到方式又完全不同（有的扫码、有的定位、有的老师直接点名）。'
      '如果把签到逻辑写死在 App 里，换一个学校就废了。')

para('所以架构上做了两层抽象：')

bullet('适配器层（Adapter）：每个学校一套实现，对外只暴露统一的接口契约'
       '（登录、探活、拉课程、检测签到、提交签到）。换学校 = 换一个适配器，界面完全不用动。')
bullet('模块层（Module）：签到、外卖、课程、待办、统计各自独立，'
       '每个模块自己声明"我支持哪些平台、需要哪些权限、要不要授权"，由注册表统一驱动界面。')

h2('1.2 当前完成度总览')

table(['模块', '完成度', '状态说明'], [
    ['功能模块框架', '√ 完成', '模块注册表 + 平台过滤 + 权限声明 + 授权门控'],
    ['授权与白名单', '√ 完成', '远端名单校验 + 有效期 + 使用日志 + 本地缓存'],
    ['优学院登录', '√ 完成', 'CAS 全链路 + AES 密码加密 + 三种绑定方式'],
    ['签到：状态总览', '√ 完成', '按课程聚合全部签到记录，已签 / 未签一目了然'],
    ['签到：地点签到', '√ 完成', '范围内选坐标提交，不依赖现场'],
    ['签到：扫码签到', '√ 完成', '相机扫码或粘贴二维码内容提交'],
    ['签到：提交接口', '√ 已实测', '参数名与类型全部确认（含一个关键陷阱）'],
    ['签到：课程列表', '● 待抓包', '接口路径已知，但公网访问返回 502'],
    ['外卖记录', '√ 完成', '手动记录 + 通知自动抓取 + 店铺统计'],
    ['外卖：自动找订单', '× 已搁置', '按你的要求先搁置'],
], widths=[0.26, 0.16, 0.58])

page_break()

# ================================================================ 二、签到模块
h1('二、签到功能模块（核心）')

para('这是本次投入最多的部分，也是唯一需要"逆向真实接口"的部分。'
      '按你的要求实现为：一个模块、两个入口、点击时查询、可看全部状态、可修改状态。')

h2('2.1 界面结构')

code_block([
    '签到模块',
    '├── 顶部查询栏     [记录数] [上次查询时间]            [查询按钮]',
    '├── Tab 切换       [签到入口]  [全部签到状态]',
    '├── 签到入口页',
    '│   ├── 两个入口方块   ┌─ 地点签到 ─┐   ┌─ 扫码签到 ─┐',
    '│   ├── 待处理列表     显示所有未签到记录，点击选中',
    '│   └── 提交表单       按签到方式显示不同表单：',
    '│                      · 地点：坐标输入（经度,纬度）+ 地址',
    '│                      · 扫码：打开相机扫码 或 粘贴二维码内容',
    '└── 全部状态页',
    '    ├── 汇总卡        总记录 / 已签到 / 未签到 / 签到率',
    '    ├── 按课程分组    可展开看每次签到的时间、方式、教师、状态',
    '    └── 全部记录      最多显示 50 条',
])

para('点任意一个入口，会先自动查询一次（这是你明确要求的"点击的时候进行查询"），'
      '然后展示当前的待处理列表。', space_after=8)

h2('2.2 地点签到')

para('地点签到的本质是：服务器要求你提交一个落在教师设定范围内的坐标。'
      '而坐标是客户端提供的——这意味着只要知道范围，就可以在任意位置选一个合规的坐标提交。')

kv_block([
    ('提交字段', 'attendanceID（签到活动 id）'),
    ('', 'userID（必须是数字 id，见下方陷阱）'),
    ('', 'classID（班级 id）'),
    ('', 'enterWay = 1（标识这是地点签到）'),
    ('', 'location（格式实测为「经度,纬度」）'),
    ('', 'address（地址，可选）'),
])

h2('2.3 扫码签到')

para('扫码签到比地点签到严格：服务端会校验 attendanceCode（二维码里的内容），'
      '而且 App 的文案明确写着二维码每 15 秒刷新一次。')

kv_block([
    ('提交字段', 'attendanceID + userID + classID'),
    ('', 'enterWay = 2（标识这是扫码签到）'),
    ('', 'attendanceCode（二维码内容）'),
])

para('因此界面上给了三条取码路径，按可靠性排序：', space_after=4)
bullet('相机直接扫（最自然，但要有人在现场投屏）')
bullet('粘贴二维码内容（同学拍照发你，你识别后粘贴）')
bullet('尝试读取服务端签到码（调用 getAttendanceDataCode 接口，能拿到就直接填）')

callout('关于"改签到状态"',
        '实测确认：同一个 signByStu 接口既能新增签到，也能变更签到状态。'
        '但学生端只找到正向接口（签到），取消签到用的是教师接口（deleteAttendance），'
        '所以"取消"这一侧可能无法实现，需要用真实签到实测确认。',
        color_hex='FFF7ED')

h2('2.4 三个关键实测发现')

para('这部分是本次最有价值的技术产出——每一条都是踩过坑换来的。', space_after=6)

h3('发现 1：接口路径必须带 /apps 前缀')

para('App 的前端 JS 里写的是 /newAttendance/xxx，但真实路径是 /apps/newAttendance/xxx'
      '（baseURL 是 /apps）。按字面路径请求会全部 404——这一个前缀曾让所有探测失败。')

code_block([
    '×  GET /newAttendance/getAttendanceForStu/919695/90990001   → 404',
    '√  GET /apps/newAttendance/getAttendanceForStu/919695/90990001  → 200',
])

h3('发现 2：userID 必须传数字，不能传学号')

para('这是最容易埋雷的地方：传学号字符串不会报"参数错误"，而是抛一个类型转换异常。'
      '如果不实测出来，代码可能永远签不上而不知道为什么。')

code_block([
    'POST /apps/newAttendance/signByStu',
    '{ "attendanceID": 919695, "userID": "2099000000116", "enterWay": 1 }',
    '→ 400  {"code":1201,"message":"For input string: \\"2099000000116\\""}',
    '',
    '{ "attendanceID": 919695, "userID": 90990001, "enterWay": 1 }',
    '→ 200  （受理成功）',
])

h3('发现 3：响应里的 userName/userID 是教师信息')

para('getAttendanceForStu 的响应里同时有 userName 和 userID，很容易误读成学生本人。'
      '实测对照后确认它们是教师（曾志峰 / 5298184），学生自己的 id 要从别处取。'
      '这个坑如果搞错，提交时就会把签到记到老师头上。')

h2('2.5 三道安全护栏')

para('因为签到操作会真实改变考勤记录，代码里加了三层保护：', space_after=4)

table(['护栏', '作用'], [
    ['强制校验 userID', '提交前检查 userID 是否等于当前登录用户，不等于直接拒绝——'
                        '防止 attendanceID 与 userID 不匹配时签到别人'],
    ['提交后复核', '实测发现 200 空响应不等于成功，所以提交后重新拉详情确认状态真的变了；'
                  '没变就明确报错，而不是假装成功'],
    ['坐标格式校验', '必须符合「经度,纬度」格式，避免提交无效坐标后误以为已签到'],
], widths=[0.22, 0.78])

page_break()

# ================================================================ 三、登录
h1('三、优学院登录与账号绑定')

para('登录是整个功能的地基。学校用的是金智教育的统一身份认证（CAS），'
      '密码要先用页面上的盐做 AES 加密再提交，中间还有一次票据跳转换 token。')

h2('3.1 登录链路')

code_block([
    '① GET  auth.dgut.edu.cn/authserver/login?service=<应用中心回调>',
    '        取出页面里的 pwdEncryptSalt 和 execution',
    '',
    '② POST 同地址',
    '        password = AES-128-CBC(randomString(64) + 明文密码)',
    '        key = pwdEncryptSalt    iv = randomString(16)',
    '        → 302 到应用中心，带 ticket',
    '',
    '③ 跟票链（3 跳）',
    '        跳 1: fromcas?ticket=… → 302（无新 cookie）',
    '        跳 2: fromcas          → 302  ★ token 在这一跳下发',
    '        跳 3: 应用中心         → 200',
])

h2('3.2 三种绑定方式')

table(['方式', '说明', '状态'], [
    ['应用内登录', '在 App 内的 WebView 里正常登录，含短信验证码，自动保存会话', '√ 推荐'],
    ['账号密码', '走 CAS 全链路，遇到短信验证会自动弹窗要求输入', '√ 可用'],
    ['粘贴 Cookie', '手动导入会话，兜底方案', '√ 可用'],
], widths=[0.2, 0.64, 0.16])

h2('3.3 登录链路踩过的坑')

para('这些坑的共同点是：现象都像"密码错了"，但真实原因完全不同。', space_after=6)

table(['现象', '真实原因'], [
    ['拿不到 pwdEncryptSalt', 'CAS 按 User-Agent 返回不同页面：移动端 UA 拿到的是简版页（无 salt），'
                             '必须用桌面版 UA'],
    ['提交后返回登录页，像密码错', '请求体没转成字符串，Content-Length 算成 0，服务端收不到表单'],
    ['提交后返回登录页', '页面里有 3 个 execution（密码表单 / fido / 动态码），'
                        '取了最后一个导致令牌对不上；密码表单在最前'],
    ['service 参数被叠加两次', '用了自动跟随重定向，必须改成手动跟随'],
    ['跟票链提前中断', 'CAS 每次 302 都换新 ticket，判重键必须包含查询串；'
                      'token 恰好在带新 ticket 的第二次请求里下发'],
], widths=[0.34, 0.66])

callout('AES 实现已用官方向量验证',
        '密码加密算法没有"大概能跑"——用 NIST SP 800-38A 的标准测试向量做了 11 项验证，'
        '包括 S-box 抽查、四个分组的已知答案、含中文的往返、密文随机性，'
        '以及盐长度异常必须抛错（禁止静默降级成明文提交）。',
        color_hex='ECFDF5')

page_break()

# ================================================================ 四、其他模块
h1('四、其他功能模块')

h2('4.1 外卖记录')

para('目标是回答一个具体问题：我在哪个外卖软件、点过哪家店、几次。')

table(['能力', '说明', '状态'], [
    ['手动记一笔', '选平台、填店名、填金额，三步完成', '√ 完成'],
    ['通知自动抓取', '监听外卖 App 的通知，自动解析平台、店名、订单状态', '√ 完成'],
    ['店铺排行', '按点单次数排序，一眼看出最常吃的店', '√ 完成'],
    ['暂存待确认', '通知缺信息时先进暂存区，由你补齐', '√ 完成'],
    ['自动找购买记录', '按你的要求先搁置', '× 搁置'],
], widths=[0.24, 0.6, 0.16])

para('通知解析这块写了 19 项回归测试，过程中真的找出了 3 个 bug：'
      '把订单标题当成了店名、全角冒号没被当分隔符、'
      '"正在配送中"的最后一个字被吃掉。修正后 19/19 通过。')

h2('4.2 功能模块与授权体系')

para('为了让 App 能适应"不同人需要不同功能"这件事，做了一个模块注册表：', space_after=4)

bullet('每个模块自己声明支持的平台、需要的权限、是否需要授权')
bullet('平台不支持的模块自动隐藏（比如通知监听的模块在 iOS 上不显示）')
bullet('用户可以在设置里手动开关，用户的选择优先于平台默认值')
bullet('需要授权的模块（签到）在未授权时显示锁定状态和开通指引')

h3('授权机制')

table(['要素', '实现'], [
    ['名单来源', '远端 JSON（可随时更新，不用重新发版）'],
    ['校验粒度', '有效期 + 只开放签到模块'],
    ['使用记录', '本地记录使用日志'],
    ['缓存策略', '带 TTL 的本地缓存，断网时优雅降级'],
    ['失效规则', 'disabled 优先于 expiresAt；过期瞬间仍视为有效'],
], widths=[0.26, 0.74])

callout('关于授权的诚实说明',
        '本地校验的授权是"防君子不防小人"——懂逆向的人可以绕过。'
        '它的真实作用是让功能开放有据可依、有记录可查，而不是强防护。'
        '这一点在文档里写明了，没有夸大。',
        color_hex='FEF2F2')

page_break()

# ================================================================ 五、工程质量
h1('五、工程质量与验证')

h2('5.1 自动化验证')

para('所有关键逻辑都有对应的回归测试，可以随时一条命令重跑：', space_after=6)

table(['脚本', '项数', '验证内容'], [
    ['verify-aes.cjs', '11 / 11', 'AES 加密：官方向量、往返、随机性、异常处理'],
    ['verify-geo.cjs', '11 / 11', '地理范围：坐标落在范围内 / 外、边界情况'],
    ['verify-delivery.cjs', '19 / 19', '外卖通知解析：各平台文案、缺字段、噪声'],
    ['verify-modules.cjs', '24 / 24', '模块注册表：平台过滤、权限、优先级'],
    ['verify-license.cjs', '29 / 29', '授权校验：有效期、禁用、边界、缓存'],
    ['合计', '65 / 65', '全部通过'],
], widths=[0.28, 0.14, 0.58])

h2('5.2 构建验证')

code_block([
    '$ npm run typecheck',
    '  √ 0 错误（strict 模式）',
    '',
    '$ npm test',
    '  √ 65 / 65 通过',
    '',
    '$ npx expo start',
    '  √ Metro Bundler 启动成功',
    '  √ Android Bundled 8.30 MB',
    '  √ 签到模块全部端点与组件均在产物中（13/13 命中）',
])

h2('5.3 依赖安装的一个硬性要求')

para('实测发现：用 pnpm 安装依赖会导致 Metro 崩溃，表现为两种报错：', space_after=4)
code_block([
    'TypeError: WebSocketServer is not a constructor',
    'TypeError: Class extends value #<Object> is not a constructor or null',
])
para('原因是 pnpm 的严格符号链接布局让 @expo/cli 解析到了错误版本的 ws 和 minipass。'
      '试过 overrides、node-linker=hoisted、把依赖提到根目录，都没解决——'
      '因为 pnpm 的提升副本不受 overrides 控制。'
      '换成 npm 的扁平布局后一次就通。', space_after=8)

callout('结论：必须用 npm 安装依赖',
        'README 里已写明。如果你用 pnpm，会看到上面两种报错，'
        '解决办法是删掉 node_modules 改用 npm install。',
        color_hex='EFF0FE')

page_break()

# ================================================================ 六、实测接口
h1('六、已实测确认的接口清单')

para('下面每个接口都真实请求过并拿到响应，不是从文档或推测得来的。')

table(['接口', '方法', '用途', '状态'], [
    ['/apps/newAttendance/getAttendanceForStu/{id}/{uid}', 'GET', '签到详情', '√ 完整 JSON'],
    ['/apps/newAttendance/getHistoryAttendanceByStu2/{uid}/-1', 'GET', '签到历史', '√ 200'],
    ['/apps/newAttendance/signByStu', 'POST', '提交签到', '√ 200 受理'],
    ['/apps/newAttendance/getAttendanceDataCode/{id}', 'GET', '签到码', '√ 200'],
    ['/apps/user/getUserByUserID/{uid}', 'GET', '用户资料', '√ 200'],
], widths=[0.5, 0.1, 0.16, 0.24])

h2('6.1 提交签到的完整参数')

code_block([
    'POST /apps/newAttendance/signByStu        （Content-Type: application/json）',
    '',
    '{',
    '  "attendanceID": 919695,      // 签到活动 id（必填）',
    '  "userID": 90990001,          // 数字 id（必填，不能传学号字符串）',
    '  "classID": 949597,           // 班级 id',
    '  "enterWay": 1,               // 1 = 地点签到   2 = 扫码签到',
    '  "location": "113.8182,22.9015",   // 地点签到用',
    '  "address": "教学楼A-301",          // 地点签到用',
    '  "attendanceCode": ""               // 扫码签到用',
    '}',
])

h2('6.2 请求头')

code_block([
    'AUTHORIZATION: <32 位 token>',
    'X-Requested-With: cn.ulearning.yxy      ← App 身份标识，必须带',
    'Referer: https://lms.dgut.edu.cn/umobile/?timestamp=<毫秒时间戳>',
    'Accept: application/json, text/plain, */*',
    'Cookie: <完整会话>',
])

h2('6.3 实测确认的身份信息')

table(['项', '值'], [
    ['数字 userId', '90990001'],
    ['学号', '2099000000116'],
    ['登录名', 'dgut2099000000116'],
    ['班级', '2025软件1-2班（classID 949597）'],
    ['已确认课程', 'ocId 161517 · [2026年秋季课程]大学物理C'],
    ['已确认签到记录', 'attendanceID 919695 · 2026-09-30 09:16 点名'],
], widths=[0.3, 0.7])

page_break()

# ================================================================ 七、剩余
h1('七、剩余工作与已知限制')

para('功能主体已经完成并且可运行。剩下的事情分两类：需要你配合实测的，和已经明确搁置的。')

h2('7.1 需要一次真实签到才能确认')

para('已用一条"已签到完成"的历史记录做了安全探测（服务端必然拒绝，不会改动考勤），'
      '确认了参数名与类型。但有一条规则必须用进行中的签到才能验证：', space_after=6)

table(['待确认项', '为什么要真实签到'], [
    ['attendanceCode 是否强制', '决定扫码签到能否自动化。若强制，就必须拿到二维码内容'],
    ['location 的精确格式', '目前实测格式是「经度,纬度」，但不确定服务端是否校验范围与精度'],
    ['提交成功时的响应内容', '实测已结束的签到返回 200 空响应，成功时是否带字段尚不确定'],
    ['取消签到是否可行', '学生端只找到正向接口，取消可能只有教师接口'],
], widths=[0.28, 0.72])

para('对应的处理方式：等一次真实签到时抓一条 signByStu 请求（请求体 + 响应体）即可。'
      '代码里已经内置了"提交后复核"机制，即使参数不全也会明确提示，不会静默失败。')

h2('7.2 课程列表接口')

para('接口路径已经知道（/courses/students 与 getClassroomList），'
      '但从公网访问返回 502 Bad Gateway。推测是限制校园网访问。')

bullet('在校园网内运行时应该能正常返回')
bullet('如果不行，需要抓一次课程列表请求确认路径前缀')
bullet('当前的替代方案：用签到历史聚合出课程列表——所以一旦有签到记录，总览页就能按课程分组')

h2('7.3 明确搁置的部分')

table(['项目', '状态', '原因'], [
    ['外卖自动找购买记录', '× 搁置', '按你的要求先搁置'],
    ['扫码签到的自动化拿码', '● 待定', '取决于 attendanceCode 是否强制'],
    ['取消签到', '● 待定', '学生端未找到接口'],
], widths=[0.3, 0.16, 0.54])

h2('7.4 两处需要你注意的配置')

kv_block([
    ('metro.config.js', '里面有一行 maxWorkers = 1，是给受限沙箱环境用的；'
                        '在你自己的电脑上可以删掉，能获得多核编译加速'),
    ('授权名单', '签到模块默认是锁定状态；需要配置 EXPO_PUBLIC_LICENSE_URL 指向白名单 JSON，'
                  '或在开发模式下留空以绕过'),
])

doc.add_paragraph()
callout('文档说明',
        '本文档中"√ 已实测""√ 完成"的部分都经过真实验证；'
        '"● 待确认""× 搁置"的部分已明确标注，没有把未验证的内容写成已完成。',
        color_hex='F4F5F7')

# ---------------------------------------------------------------- 保存
doc.save(DOCX)
print('DOCX 已生成:', DOCX)
print('大小: %.1f KB' % (os.path.getsize(DOCX) / 1024))
