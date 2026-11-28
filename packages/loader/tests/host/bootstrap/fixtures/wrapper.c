#ifdef _WIN32
#define NAPI_IMPORT __declspec(dllimport)
#define NAPI_EXPORT __declspec(dllexport)
#else
#define NAPI_IMPORT
#define NAPI_EXPORT __attribute__((visibility("default")))
#endif

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
NAPI_IMPORT int napi_get_global(napi_env env, napi_value *result);
NAPI_IMPORT int napi_get_named_property(napi_env env, napi_value value, const char *name, napi_value *result);

NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value global, wrapper;
    if (napi_get_global(env, &global) != 0 ||
        napi_get_named_property(env, global, "hostTestWrapper", &wrapper) != 0) {
        return exports;
    }
    return wrapper;
}
