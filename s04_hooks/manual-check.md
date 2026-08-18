# s04: Hooks 手动验证清单

s03 的三道关卡在 [s03 的清单](../s03_permission/manual-check.md)里验过，这里不重复判定逻辑本身（s04 直接复用 `checkDenyList` / `checkRules`，见 `main.ts:181-188`），只看 hook 机制带来的新行为，以及 `main.test.ts` 用 fake logger 覆盖不到的部分：终端上的 hook 输出顺序、transcript 里的 `HOOK REGISTER` / `HOOK RESULT` 记录、真实 readline 提示。

每次运行会新建一份 transcript，所以先起 REPL，再开第二个终端跟最新那份：

```sh
pnpm dev s04_hooks/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s04_hooks/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 HOOK REGISTER

REPL 启动后还没输入任何问题，transcript 里就应该有一节 `HOOK REGISTER`：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

`PreToolUse` 那行的两个名字必须是这个顺序（`main.ts:255-256`），顺序决定了下面第 3 项的结果。

## 2. 一次正常调用：四个 hook 的完整时间线

- `What files are in the current directory?`

终端上按这个顺序出现（颜色在括号里）：

1. `[HOOK] UserPromptSubmit(contextInjectHook): working in <cwd>`（灰）
2. `🔧 bash({"command":"ls"})`（青，来自 `printProse`）
3. `[HOOK] PreToolUse(logHook): bash`（灰）
4. 工具输出预览（灰，`main.ts:330`）
5. `[HOOK] Stop(summaryHook): session used 1 tool calls`（灰）
6. 最终回答（绿）

第 1 步在 `agentLoop` 之外触发（REPL 里的 `main.ts:385`），所以每轮用户输入只出现一次，而不是每次 LLM 往返一次。

第 5 步的计数值得多试一轮：接着问 `Now count the lines in package.json`，第二轮的 `session used N tool calls` 会累加，因为 `summaryHook` 数的是整个 `history` 里的 `tool_result` block（`main.ts:236-243`），不是本轮的。

## 3. PreToolUse 的短路：permissionHook 先于 logHook

- `Run this exact command: sudo ls`

预期只看到红色 `[HOOK] PreToolUse(permissionHook): Blocked: 'sudo' is on the deny list`，**不会**看到 `[HOOK] PreToolUse(logHook): bash`。`trigger` 拿到第一个非 null 就 return（`main.ts:124`），后面的 hook 根本不跑，被拦的调用因此不会进日志。

同一时刻 transcript 里应该出现一节 `HOOK RESULT`：

```plaintext
PreToolUse → permissionHook([{"type":"tool_use",...}]) blocked: Permission denied by deny list
```

注意两个字符串不一样：终端上是 `checkDenyList` 的原因（给人看的），喂回模型的是 `Permission denied by deny list`（`main.ts:184`，给模型看的）。

## 4. 真实 readline 确认：hook 里 await 用户输入

- `Delete the file tmp/note.txt`（先 `Write a file tmp/note.txt with content "hi"` 造出来）

命中 `checkRules` 的破坏性规则，`permissionHook` 会 `await confirm(...)`，弹出 `Allow? [y/N]`。这是 `main.test.ts` 用 fake `Confirm` 替掉的那部分，必须手动跑一次才算验过。

- 输 `n`：终端有 `HOOK RESULT ... blocked: Permission denied by user`，文件还在。
- 输 `y`：不产生 `HOOK RESULT`（`logHookResult` 只记录被拦的，`main.ts:158`），但 `makeConfirm` 会写一节 `PERMISSION ... Decision: allow`，文件消失。

等待输入期间整个循环是挂起的：hook 是 async 的，`trigger` 在 `await callback(...)` 上等着（`main.ts:121`），下一个 hook 和工具执行都不会先跑。可以在提示出现后停十几秒再输，确认没有任何东西抢跑。

## 5. PostToolUse 拿到输出但不改它

- `Read the file package.json`

`largeOutputHook` 在正常输出下静默（阈值 10 万字符，`main.ts:213`），所以这一步的观察点是「没有告警」加上「模型收到的内容和终端预览一致」。想真的触发告警：

- `Run this exact command: yes hello | head -c 200000`

这条实际上**不会**告警，而这正是要验证的点：`runBash` 在返回前先把输出截到 5 万字符（`../s03_permission/main.ts:80`），而 `largeOutputHook` 的阈值是 10 万，bash 的输出永远够不着。

真要看到告警只能走 `read_file`（它不截断，`../s03_permission/main.ts:83-100`）：先造一个大文件

```sh
node -e 'require("fs").writeFileSync("tmp/big.txt","x".repeat(150000))'
```

再问 `Read the file tmp/big.txt`，此时应出现黄色 `[HOOK] PostToolUse(largeOutputHook): Large output from read_file: 150000 chars`。告警之后工具结果照常进 `results`（`main.ts:336-340`），模型收到的仍是完整输出：PostToolUse 只观察，不改结果。

## 6. Stop hook 强制续轮（需要临时改代码）

默认的 `summaryHook` 永远返回 null，所以「Stop hook 让循环自己续命」这条路在正常运行时走不到。`main.test.ts` 里已用 fake 覆盖，想在真实模型上看一次，临时在 `registerDefaultHooks` 里加：

```ts
let fired = false;
hooks.register("Stop", () => {
  if (fired) return null;
  fired = true;
  return "Before you finish, list the files you touched.";
});
```

然后问一个一步就能答完的问题。预期：模型第一次想结束时被这条注入的 user 消息拉回来，又跑了一轮才真正退出。验完记得改回去。
