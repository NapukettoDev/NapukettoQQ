---
"@napuketto/adapter": patch
---

fix(adapter): parseCqMessage 改为线性 indexOf 扫描，消除不可信消息文本下的多项式回溯（CodeQL polynomial-redos 高危告警）
