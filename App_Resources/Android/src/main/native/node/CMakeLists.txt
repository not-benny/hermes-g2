cmake_minimum_required(VERSION 3.10)
project(faceclaw_node_bridge)

# Provided by the gradle configure step:
#   FACECLAW_LIBNODE_SO  - absolute path to the prebuilt arm64 libnode.so
#   FACECLAW_NODE_INCLUDE - absolute path to the nodejs-mobile include/node dir
if(NOT DEFINED FACECLAW_LIBNODE_SO)
  message(FATAL_ERROR "FACECLAW_LIBNODE_SO must be set")
endif()
if(NOT DEFINED FACECLAW_NODE_INCLUDE)
  message(FATAL_ERROR "FACECLAW_NODE_INCLUDE must be set")
endif()

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION "${FACECLAW_LIBNODE_SO}")

add_library(node-bridge SHARED native-lib.cpp)
target_include_directories(node-bridge PRIVATE "${FACECLAW_NODE_INCLUDE}")
target_link_libraries(node-bridge libnode log)

# 16 KB page alignment to match the rest of the app (Android 15 devices). The
# prebuilt libnode.so is only 4 KB-aligned, so full 16 KB support also needs a
# re-aligned libnode; this at least keeps our own bridge compliant.
target_link_options(node-bridge PRIVATE
  -Wl,-z,max-page-size=16384
  -Wl,-z,common-page-size=16384)
