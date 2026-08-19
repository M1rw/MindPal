cmake_minimum_required(VERSION 3.16)
project(mindpal_network_assistant LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(netassist src/main.cpp)
target_include_directories(netassist PRIVATE src)

add_executable(netassist_tests tests/test_core.cpp)
target_include_directories(netassist_tests PRIVATE src)

enable_testing()
add_test(NAME core COMMAND netassist_tests)
