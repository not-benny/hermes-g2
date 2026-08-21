// JNI bridge that starts an embedded Node.js runtime (nodejs-mobile's
// libnode.so) inside the app, on a background thread, and pipes Node's
// stdout/stderr into logcat. Modeled on JaneaSystems' nodejs-mobile
// native-gradle sample. The Node script itself hosts the WhatsApp engine and a
// 127.0.0.1 loopback server the NativeScript layer talks to.

#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "FaceclawNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// --- stdout/stderr -> logcat --------------------------------------------------
static int s_pipe[2];
static pthread_t s_logThread;

static void *logPipeReader(void *) {
  ssize_t n;
  char buf[2048];
  while ((n = read(s_pipe[0], buf, sizeof(buf) - 1)) > 0) {
    if (buf[n - 1] == '\n') n--;
    buf[n] = '\0';
    __android_log_write(ANDROID_LOG_INFO, "FaceclawNodeJS", buf);
  }
  return nullptr;
}

static void startStdoutRedirect() {
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(s_pipe);
  dup2(s_pipe[1], STDOUT_FILENO);
  dup2(s_pipe[1], STDERR_FILENO);
  if (pthread_create(&s_logThread, nullptr, logPipeReader, nullptr) == 0) {
    pthread_detach(s_logThread);
  }
}

// --- node::Start bridge -------------------------------------------------------
extern "C" JNIEXPORT jint JNICALL
Java_com_faceclaw_app_FaceclawNodeRuntime_nativeStartNode(JNIEnv *env, jobject /*thiz*/,
                                                          jobjectArray arguments) {
  startStdoutRedirect();

  int argc = env->GetArrayLength(arguments);
  if (argc < 1) {
    LOGE("nativeStartNode called with no arguments");
    return 1;
  }

  // libuv wants argv to be a single contiguous allocation.
  size_t total = 0;
  for (int i = 0; i < argc; i++) {
    auto arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *str = env->GetStringUTFChars(arg, nullptr);
    total += strlen(str) + 1;
    env->ReleaseStringUTFChars(arg, str);
    env->DeleteLocalRef(arg);
  }

  auto *argv = static_cast<char **>(malloc((argc + 1) * sizeof(char *)));
  auto *buffer = static_cast<char *>(malloc(total));
  char *cursor = buffer;
  for (int i = 0; i < argc; i++) {
    auto arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *str = env->GetStringUTFChars(arg, nullptr);
    size_t len = strlen(str) + 1;
    memcpy(cursor, str, len);
    argv[i] = cursor;
    cursor += len;
    env->ReleaseStringUTFChars(arg, str);
    env->DeleteLocalRef(arg);
  }
  argv[argc] = nullptr;

  LOGI("starting embedded node (%d args)", argc);
  int result = node::Start(argc, argv);
  LOGI("embedded node exited with %d", result);

  free(argv);
  free(buffer);
  return static_cast<jint>(result);
}
