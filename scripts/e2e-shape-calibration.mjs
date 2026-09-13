// biome-ignore-all lint/suspicious/noConsole: 校准脚本（结论输出用 console）
/**
 * e2e-shape-calibration.mjs：读类 API 返回形状校准脚本（2026-09-08 T10）。
 *
 * 用途：经 OB11 WS 动作面（与 kernel API 同链路）无副作用调用读类接口，
 * 核对 kernel 源码中「待探测校准」注释与真实返回形状：
 *   get_group_info / get_group_member_list / get_group_member_info /
 *   get_group_system_msg（→ kernel getSingleScreenNotifies/getMemberInfo 等）
 * 仅读类；写类（kick/rename/createFolder）严禁调用。
 * 用法：node scripts/e2e-shape-calibration.mjs [wsUrl] [token] [groupId]
 */
const url = process.argv[2] ?? "ws://127.0.0.1:3001";
const token = process.argv[3] ?? "test";
const groupId = process.argv[4];

const ws = new WebSocket(`${url}?access_token=${token}`);
let seq = 0;
const pending = new Map();

function call(action, params) {
    seq += 1;
    const echo = `cal-${seq}`;
    return new Promise((resolve) => {
        pending.set(echo, resolve);
        ws.send(JSON.stringify({ action, params, echo }));
    });
}

/** 递归提取 JSON 形状（键名 + 类型 + 数组首元素），不输出个人数据值。 */
function shape(value, depth = 0) {
    if (depth > 4) {
        return typeof value;
    }
    if (Array.isArray(value)) {
        return value.length === 0 ? "[]" : [shape(value[0], depth + 1)];
    }
    if (value === null) {
        return "null";
    }
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 30)) {
            out[k] = shape(v, depth + 1);
        }
        return out;
    }
    return typeof value;
}

ws.addEventListener("open", async () => {
    try {
        const login = await call("get_login_info", {});
        console.log("get_login_info:", JSON.stringify(shape(login.data)));
        let gid = groupId;
        if (gid === undefined) {
            const groups = await call("get_group_list", {});
            const first = groups.data?.data?.[0] ?? groups.data?.[0];
            gid = first?.group_id;
            console.log("get_group_list item:", JSON.stringify(shape(first)));
        }
        if (gid !== undefined) {
            const members = await call("get_group_member_list", { group_id: Number(gid) });
            const memberList = Array.isArray(members.data) ? members.data : members.data?.data;
            console.log(
                "get_group_member_list:",
                JSON.stringify({ retcode: members.retcode, count: memberList?.length }),
            );
            console.log("member item:", JSON.stringify(shape(memberList?.[0])));
            const firstUserId = memberList?.[0]?.user_id ?? memberList?.[0]?.data?.user_id;
            if (firstUserId !== undefined) {
                const one = await call("get_group_member_info", {
                    group_id: Number(gid),
                    user_id: Number(firstUserId),
                });
                console.log(
                    "get_group_member_info:",
                    JSON.stringify({ retcode: one.retcode, data: shape(one.data) }),
                );
            }
            const sysmsg = await call("get_group_system_msg", { count: 5 });
            console.log(
                "get_group_system_msg:",
                JSON.stringify({
                    retcode: sysmsg.retcode,
                    data: shape(sysmsg.data),
                }),
            );
        }
    } finally {
        ws.close();
        setTimeout(() => process.exit(0), 300);
    }
});

ws.addEventListener("message", (ev) => {
    let data;
    try {
        data = JSON.parse(String(ev.data));
    } catch {
        return;
    }
    const resolve = pending.get(data.echo);
    if (typeof resolve === "function") {
        pending.delete(data.echo);
        resolve(data);
    }
});

ws.addEventListener("error", () => {
    console.error("WS 错误");
    process.exit(1);
});
setTimeout(() => {
    console.error("超时");
    process.exit(2);
}, 20_000);
