---
"create-napukettoqq": patch
---

fix(create-napukettoqq): quoteShellArg 按 MSVCRT 规则补全反斜杠转义（紧邻引号的反斜杠串翻倍 + 结尾收口翻倍），修复 CodeQL incomplete-sanitization 高危告警
