const { appendFileSync } = require("node:fs");

const trace = (step) => appendFileSync(process.env.HOST_TEST_TRACE, `${step}\n`);
const noop = () => undefined;
let initListener;
let ready = false;
let o3 = false;

function listeners(name) {
    return {
        [`addKernel${name}Listener`]() {
            trace(`add:${name}`);
            if (process.env.HOST_TEST_FAIL === "register" && name === "Group") {
                throw new Error("synthetic listener failure");
            }
            return 1;
        },
        [`removeKernel${name}Listener`]() {
            trace(`remove:${name}`);
        },
    };
}

const msg = {
    ...listeners("Msg"),
    sendMsg: noop,
    recallMsg: noop,
    getMsgs: noop,
    getMsgsByMsgId: noop,
    async setStatus() {
        trace("online");
        return { result: 0 };
    },
};
const group = {
    ...listeners("Group"),
    getGroupList: noop,
    getGroupDetailInfo: noop,
    getAllMemberList: noop,
    getSingleScreenNotifies: noop,
    operateSysNotify: noop,
    kickMemberV2: noop,
};
const buddy = { ...listeners("Buddy"), getBuddyListFromCache: noop, getBuddyNick: noop };
const recent = { ...listeners("RecentContact"), getRecentContactList: noop };

const session = {
    init(_config, _depends, _dispatcher, listener) {
        trace("session.init");
        initListener = listener;
    },
    getMsgService: () => (ready ? msg : null),
    getGroupService: () => group,
    getBuddyService: () => buddy,
    getRecentContactService: () => recent,
    getTicketService: () => ({ forceFetchClientKey: noop }),
    getRichMediaService: () => ({ getGroupFileList: noop }),
    getFlashTransferService: () => ({
        createFlashTransferUploadTask: noop,
        addFileSetUploadListener: noop,
        sendFlashTransferMsg: noop,
    }),
    getProfileService: () => ({ getUserDetailInfo: noop, getUserDetailInfoByUin: noop }),
    getProfileLikeService: () => ({ setBuddyProfileLike: noop }),
};
const startup = {
    start() {
        trace("startup.start");
        if (!initListener) throw new Error("session.init must run first");
        ready = true;
        initListener.onSessionInitComplete(0);
    },
};
const login = {
    ...listeners("Login"),
    initConfig() {
        trace("login.initConfig");
    },
    async getLoginList() {
        trace("login.list");
        if (!o3) throw new Error("O3 listener is required");
        return {
            result: 0,
            LocalLoginInfoList: [{ uin: "10000", uid: "synthetic", nickName: "fixture" }],
        };
    },
    getMsfStatus: () => 3,
    async quickLoginWithUin() {
        trace("login.quick");
        return { result: "0", loginErrorInfo: { errMsg: "" } };
    },
};

Object.defineProperty(globalThis, "hostTestWrapper", {
    get() {
        trace("dlopen");
        return {
            NodeIO3MiscService:
                process.env.HOST_TEST_FAIL === "o3"
                    ? undefined
                    : {
                          get: () => ({
                              addO3MiscListener(listener) {
                                  trace("add:O3");
                                  listener.getOnAmgomDataPiece();
                                  o3 = true;
                              },
                          }),
                      },
            NodeIQQNTWrapperEngine: {
                get: () => ({ initWithDeskTopConfig: () => trace("engine.init") }),
            },
            NodeIQQNTStartupSessionWrapper: {
                create() {
                    trace("startup.create");
                    return startup;
                },
            },
            NodeIQQNTWrapperSession: {
                getNTWrapperSession() {
                    trace("session.get");
                    return session;
                },
            },
            NodeIKernelLoginService: { get: () => login },
        };
    },
});

if (!process.env.HOST_TEST_REAL_DLOPEN) {
    const load = process.dlopen;
    process.dlopen = (target, filename, flags) => {
        if (filename === process.env.NAPUKETTO_WRAPPER_PATH) {
            target.exports = globalThis.hostTestWrapper;
            return;
        }
        return load(target, filename, flags);
    };
}
