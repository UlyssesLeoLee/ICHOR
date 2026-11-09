/**
 * ATS-107 真实浏览器夹具的常量。
 *
 * 断言文本放在这里而不是写死在用例里，是因为探针要按它核对两边的错误
 * 信息：Bridge 报出来的失败原因里必须包含引擎自己写的这段断言文本。
 * 改了这里，`tests/expected.json` 也必须一起改，否则探针会失败，而不是
 * 悄悄接受新的行为。
 */
export const EXPECTED_FAILURE_TEXT = 'ATS-107 FAIL — this text is intentionally absent';

/** 两条用例的标题。探针按标题逐条对账，标题就是用例的身份。 */
export const PASSING_TITLE = 'ATS-107 passing case renders the offline page';
export const FAILING_TITLE = 'ATS-107 failing case asserts a text that is absent';
