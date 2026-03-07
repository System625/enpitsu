Run pyright .
  pyright .
  shell: /usr/bin/bash -e {0}
  env:
    pythonLocation: /opt/hostedtoolcache/Python/3.11.14/x64
    PKG_CONFIG_PATH: /opt/hostedtoolcache/Python/3.11.14/x64/lib/pkgconfig
    Python_ROOT_DIR: /opt/hostedtoolcache/Python/3.11.14/x64
    Python2_ROOT_DIR: /opt/hostedtoolcache/Python/3.11.14/x64
    Python3_ROOT_DIR: /opt/hostedtoolcache/Python/3.11.14/x64
    LD_LIBRARY_PATH: /opt/hostedtoolcache/Python/3.11.14/x64/lib
/home/runner/work/enpitsu/enpitsu/backend/agent.py
  /home/runner/work/enpitsu/enpitsu/backend/agent.py:57:34 - error: Argument of type "list[str]" cannot be assigned to parameter "response_modalities" of type "list[Modality] | None" in function "__init__"
    "Literal['AUDIO']" is not assignable to "Modality" (reportArgumentType)
/home/runner/work/enpitsu/enpitsu/backend/image_gen.py
  /home/runner/work/enpitsu/enpitsu/backend/image_gen.py:59:66 - error: "image_bytes" is not a known attribute of "None" (reportOptionalMemberAccess)
  /home/runner/work/enpitsu/enpitsu/backend/image_gen.py:60:41 - error: Argument of type "bytes | None" cannot be assigned to parameter "s" of type "ReadableBuffer" in function "b64encode"
    Type "bytes | None" is not assignable to type "ReadableBuffer"
      "None" is incompatible with protocol "Buffer"
        "__buffer__" is not present (reportArgumentType)
/home/runner/work/enpitsu/enpitsu/backend/main.py
  /home/runner/work/enpitsu/enpitsu/backend/main.py:48:26 - error: "lower" is not a known attribute of "None" (reportOptionalMemberAccess)
  /home/runner/work/enpitsu/enpitsu/backend/main.py:52:55 - error: Argument of type "str | None" cannot be assigned to parameter "filename" of type "str" in function "extract_text"
    Type "str | None" is not assignable to type "str"
      "None" is not assignable to "str" (reportArgumentType)
5 errors, 0 warnings, 0 informations
Error: Process completed with exit code 1.