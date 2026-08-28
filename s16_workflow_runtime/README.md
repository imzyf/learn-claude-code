# s16: Workflow Runtime 手动验证清单

本章在 s15 宿主的工具池上加一个 `Workflow` 工具：模型只给 workflow 名、`args` 和可选的 `resume_from_run_id`，宿主按名字从 registry 取出可信的脚本，一次 `tool_use` 里跑完整套编排。要看的东西有三样：编排原语（`agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow`）跑出来的事件流、落在 `.runtime/` 的四份产物、以及 journal 驱动的续跑。

`demo` 和 `resume` 用 `MockAgentRunner`，不需要 API key，同样的输入永远给同样的结果，本清单第 1 到 10 节都在这两个命令上验。第 11 节要真实 API。

## 起跑

```sh
# 必须在仓库根目录跑：s15 的工具、worktree 校验和 .memory 都以 process.cwd() 为根
pnpm dev s16_workflow_runtime/main.ts demo
```

跨次运行的状态全在 `.runtime/`，开跑前先清干净，需要重来时也是这一条：

```sh
rm -rf s16_workflow_runtime/.runtime
```

后面多次要取本次运行的产物，先在校验终端里存两个变量：

```sh
S=s16_workflow_runtime/.runtime
R=$(cat $S/last_run.txt)
```

## 1. demo：一次调用跑完整套编排

`demo` 的完整输出应该是这个形状（`runId` 每次不同，其余固定）：

```plaintext
launching workflow `review-changes`

  event      async_launched     runId=wf_review-changes_xxxxxxxxxxxxxxxx taskId=local_workflow_wf_review-changes_xxxxxxxxxxxxxxxx
  event      task_started       workflow=review-changes phases=Review,Verify resume=false
  progress   workflow_phase   title=Review
  progress   workflow_agent   label=audit:correctness phase=Review status=done
  progress   workflow_agent   label=audit:security phase=Review status=done
  progress   workflow_agent   label=audit:performance phase=Review status=done
  progress   workflow_agent   label=audit:style phase=Review status=done
  progress   workflow_phase   title=Verify
  progress   workflow_agent   label=verify:correctness:audit:correctness #1 phase=Verify status=done
  ...
  progress   workflow_log     message=confirmed 6 real finding(s)
  event      task_notification  status=completed agents=11 tokens=862 outputFile=.runtime/wf_review-changes_xxxxxxxxxxxxxxxx.output.json

result:
  [medium] performance: audit:performance #1
  ...
  [low   ] security: audit:security #2

status=completed  agents=11  tokens=862  journal=.runtime/wf_review-changes_xxxxxxxxxxxxxxxx.journal.jsonl
```

判据有三条。

第一，事件流的两头是 `async_launched` + `task_started` 和 `task_notification`，中间全是 `progress`。`async_launched` 在脚本执行之前就发了：这是「启动信封先落地，再跑」，不是跑完才补一条。

第二，`agents=11` = 4 次 audit + 7 次 verify。verify 的次数取决于 audit 报了几条 finding，mock runner 按 prompt 的稳定哈希决定报 1 条还是 2 条，所以这个 11 是固定的，不是随机的。再跑一次 `demo`，`runId` 变、`agents` 和 `tokens` 不变。

第三，`result` 那几行按 severity 排过序（`high` -> `medium` -> `low`），排序发生在脚本里，不是模型决定的。

## 2. phase 是 upsert

`Verify` 阶段在 `pipeline` 的 4 个 item 里各被 `ctx.phase("Verify")` 喊了一次，但只播报一次：

```sh
pnpm dev s16_workflow_runtime/main.ts demo | grep -c workflow_phase   # 期望 2
```

多喊不重复播报，靠的是 `phasesSeen` 这个集合。`currentPhase` 仍然每次都更新，所以后面的 `agent()` 归到正确的阶段名下 —— 判据是 verify 那几条 `progress` 的 `phase=Verify`。

## 3. pipeline 不等齐这件事 demo 看不出来

`pipeline` 和 `parallel` 的区别是有没有屏障：`parallel` 等齐所有 thunk，`pipeline` 每个 item 独立走完全部 stage，item A 在第 2 阶段时 item B 可能还在第 1 阶段。

demo 里看不出来。`MockAgentRunner` 是纯计算、立刻返回，4 个维度的 audit 在同一批微任务里就跑完了，输出永远是「4 条 audit 连着，然后 7 条 verify」。要看交错，要么用第 11 节的真实 API（各维度耗时不同），要么直接看 `main.test.ts` 的「pipeline 的 stage 之间没有屏障」那条用例，它用 `sleep` 造出 `s1:fast -> s2:fast -> s1:slow -> s2:slow` 的顺序。

## 4. 落盘的四份产物

```sh
ls $S
```

```plaintext
last_run.txt
wf_review-changes_xxxxxxxxxxxxxxxx.journal.jsonl
wf_review-changes_xxxxxxxxxxxxxxxx.json
wf_review-changes_xxxxxxxxxxxxxxxx.output.json
```

`<runId>.lock` 不在里面：它只在运行期间存在，收尾时删掉。跑完还留着 `.lock` 说明进程是被杀掉的（第 9 节）。

快照里是 workflow 名、参数和任务状态：

```sh
jq '{runId, workflowName, args: (.args | keys), status: .task.status, usage: .task.usage}' $S/$R.json
```

```json
{"runId": "wf_review-changes_...", "workflowName": "review-changes", "args": ["changes"], "status": "completed", "usage": {"agents": 11, "tokens": 862}}
```

journal 一条 `agent()` 一行，行数等于 `agents`：

```sh
wc -l < $S/$R.journal.jsonl        # 期望 11
jq -r '.key' $S/$R.journal.jsonl | head -3
```

```plaintext
agent-3219270206
agent-5824726599
agent-6982615166
```

`agent-` 后面是 10 位定长数字，由「kind + label + prompt + schema」算的稳定哈希取模得到，和第几个跑完无关。

## 5. resume：全部命中缓存

```sh
pnpm dev s16_workflow_runtime/main.ts resume
```

期望首行是黄字 `resuming wf_review-changes_...; unchanged agent() calls use the journal cache`，`task_started` 里 `resume=true`，所有 11 条 `workflow_agent` 都是 `status=cached`，收尾是：

```plaintext
status=completed  agents=0  tokens=0
```

`agents=0 tokens=0` 是这一节的判据：脚本从头到尾重新执行了一遍（`phase`、`log`、排序都重跑了），但每个 `agent()` 都在 journal 里对上了记录，没有一次真的调用 runner。`result` 和上一次完全一致。

## 6. 删掉一条 journal 记录，只有那一条重跑

```sh
cp $S/$R.journal.jsonl /tmp/j.bak
grep -v 'audit:correctness' $S/$R.journal.jsonl > /tmp/j && mv /tmp/j $S/$R.journal.jsonl
pnpm dev s16_workflow_runtime/main.ts resume | grep correctness
```

```plaintext
  progress   workflow_agent   label=audit:correctness phase=Review status=done
  progress   workflow_agent   label=verify:correctness:audit:correctness #1 phase=Verify status=cached
```

收尾是 `agents=1 tokens=71`。被删的那条重跑（`done`），依赖它的 verify 仍然 `cached` —— 因为重跑给出的结果和原来一样，verify 的 prompt 就没变，key 也就没变。真实模型换个说法回答时，verify 的 key 会跟着变，那一条也会重跑。这就是「只有改过的调用以及依赖它的后续步骤才真的运行」。

```sh
cp /tmp/j.bak $S/$R.journal.jsonl   # 还原
```

## 7. 稳定 key 与并发顺序无关

清空 `.runtime` 再跑两次 `demo`，两次的 `runId` 不同，journal 的 key 集合应该完全一样：

```sh
rm -rf $S && pnpm dev s16_workflow_runtime/main.ts demo >/dev/null
A=$S/$(cat $S/last_run.txt).journal.jsonl
pnpm dev s16_workflow_runtime/main.ts demo >/dev/null
B=$S/$(cat $S/last_run.txt).journal.jsonl
diff <(jq -r .key $A | sort) <(jq -r .key $B | sort) && echo same
```

期望输出 `same`。key 如果掺了「第几个完成」这类计数器，`parallel` / `pipeline` 里的完成顺序一变，两次就对不上，续跑会把 A 的结果发给 B。

## 8. 缓存出来的结果也要过 schema

journal 是磁盘上的文件，可以被改坏，所以命中缓存的 `agent({schema})` 结果同样要校验一遍。把第一条记录的 `severity` 去掉：

```sh
R=$(cat $S/last_run.txt)
cp $S/$R.journal.jsonl /tmp/j.bak
jq -c 'if input_line_number == 1 then .value = {"findings":[{"title":"x"}]} else . end' \
   $S/$R.journal.jsonl > /tmp/j && mv /tmp/j $S/$R.journal.jsonl
pnpm dev s16_workflow_runtime/main.ts resume
cat $S/$R.output.json
```

```json
{"error": "cached agent output failed schema validation: findings: [0]: missing required key 'severity'"}
```

`status=failed agents=0 tokens=0`，但事件流照样走完 `task_notification` —— 失败也要收尾，不是中途消失。

整行坏掉是另一条路径，在读 journal 的时候就拦下来，脚本一步都不会跑：

```sh
echo 'not json' >> $S/$R.journal.jsonl
pnpm dev s16_workflow_runtime/main.ts resume   # 期望红字 invalid resume journal record at line 12
cp /tmp/j.bak $S/$R.journal.jsonl
```

这一节有个代价要知道：失败的 resume 会用 `{"error": ...}` 覆盖掉 `<runId>.output.json`，快照里的 `status` 也变成 `failed`，上一次成功的产物就没了。要留底就先 `cp`。

## 9. 锁：同一次运行不能并发，残留锁不会永久卡死

`.lock` 存在且持有者还活着，就是真的冲突：

```sh
R=$(cat $S/last_run.txt)
echo $$ > $S/$R.lock                              # 当前 shell 的 pid，肯定活着
pnpm dev s16_workflow_runtime/main.ts resume      # 期望红字 workflow run wf_... is already active
```

持有者已经没了，就当上一次运行被杀掉时留下的残留，清掉接着跑：

```sh
echo 2147483647 > $S/$R.lock                      # 一个不存在的 pid
pnpm dev s16_workflow_runtime/main.ts resume      # 期望正常跑完
ls $S | grep -c lock                              # 期望 0
```

这是 TS 版和 `code.py` 的一处实现差异。`code.py` 用 `fcntl.flock`，进程被杀时内核自动解锁；Node 没有对应能力，这里只能用 `wx` 独占创建文件，所以锁文件里写 pid，撞上已存在的锁先用信号 0 探一下持有者还在不在。代价是 pid 被系统回收再分配给别的进程时会误判成「还活着」，这时候拒绝启动，宁可多等也不抢锁。

要复现真正的残留，在 `demo` 跑到一半时 `kill -9`（mock runner 太快，可以先把 `CONCURRENCY` 改成 1 再加个 sleep），`.runtime/` 里会留下 `.lock`，下一次 `resume` 应该照常跑完。

## 10. 快照校验：runId、workflow 名、参数

三条都从 `resume` 这条路进，`resume` 用的 runId 来自 `last_run.txt`，改它就行：

```sh
cp $S/last_run.txt /tmp/lr.bak

echo not-a-run-id > $S/last_run.txt                       # 格式不对，正则拦下来，不碰磁盘
pnpm dev s16_workflow_runtime/main.ts resume              # 期望红字 invalid workflow runId

echo wf_review-changes_0000000000000000 > $S/last_run.txt  # 格式对但快照不存在
pnpm dev s16_workflow_runtime/main.ts resume              # 期望红字 resume snapshot not found for wf_...

cp /tmp/lr.bak $S/last_run.txt                            # 还原
```

workflow 名对不上那条要手工改快照：把 `<runId>.json` 里的 `workflowName` 改成别的，再 `resume`，期望 `resume runId does not match workflow meta`。参数对不上那条从 CLI 造不出来（`demo` 每次传的 `changes` 都一样），由 `main.test.ts` 的「resume 的 runId、workflow 名与参数都要对得上」覆盖。

这三条合起来是一件事：resume 会先把已保存的快照和 journal 验一遍，才动上一次的成功产物。

## 11. 交互模式：Workflow 只是工具池里的一个工具

这一节要真实 API。

```sh
pnpm dev s16_workflow_runtime/main.ts
# 另一个终端
A=$(find s16_workflow_runtime/.log -name '*_api.json' | sort | tail -1)
T=$(find s16_workflow_runtime/.log -name '*_transcript.log' | sort | tail -1)
```

还没输入任何问题时，工具池就该是 27 个：s15 的 26 个内置工具加上 `Workflow`，而且 `Workflow` 排在最后（`extraPool` 叠在内置 + MCP 工具之后）：

```sh
jq -s '[.[] | select(.config)][0].config.tools | map(.name) | length' "$A"      # 期望 27
jq -s '[.[] | select(.config)][0].config.tools | map(.name) | last' "$A"        # 期望 "Workflow"
```

- `Read s16_workflow_runtime/code.py and run the saved review-changes workflow with that file content as args.changes.`
  读 `s16_workflow_runtime/code.py`，把内容作为 `args.changes` 跑保存好的 `review-changes` workflow。

期望模型先 `read_file`，再发一次 `Workflow` 的 `tool_use`，输入里只有 `name` 和 `args`：

```plaintext
[tool_use] Workflow: {"name":"review-changes","args":{"changes":"#!/usr/bin/env python3\n..."}}
```

模型交不进来可执行代码，也交不进来元数据 —— schema 是 `strictObject`，多一个字段就被 zod 挡掉，`tool_result` 变成 `Error: ...`，宿主循环照常继续。造一次：让模型试着传 `script` 或 `meta` 字段（直接问它「用 Workflow 工具跑一个你自己写的脚本」），期望它要么被 schema 挡回，要么老实只传 `name`。

这次 `tool_use` 期间终端上会滚出和 demo 一样的事件流，只是子 agent 换成了真实 API：11 次左右的 `agent()` 都发真实请求，`tokens` 是 usage 里的真实数字，不再是 862。跑完 `.runtime/` 下多出这次的四份产物。

工具结果回到主循环时是一整份 JSON（`launched` + `result` + `task`），中间过程不进对话历史：

```sh
jq -s '[.[] | select(.tag == "api_request")] | last | .messages | tostring | contains("workflow_agent")' "$A"
```

期望 `true`（`task.progress` 在结果里）而 `false` 的是每个子 agent 的 prompt 和原始回答 —— 它们只存在于 workflow 进程内的变量和 journal 里。这就是「一次 tool_use 跑完一整套编排」省下的上下文。

四路唤醒在本章仍然在跑，因为交互模式的入口就是 s15 导出的 `runHostCli`。快速确认一下：注册一个下一分钟的 cron，或者用 `run_in_background` 跑个 `sleep 15`，到点后应该照样自己起新一轮（`[inject cron]` / `[background] collected`）。完整判据在 s15 的清单第 5 到 7 节。

`args.budget` 也是这里才好造：

- `Run review-changes on the same file, but pass budget 50 in args.`
  用同一个文件跑 `review-changes`，但在 `args` 里带上 `budget: 50`。

期望前一两次 `agent()` 就把预算吃光，工作流记为 `failed`，`result` 是 `{"error":"token budget exceeded (... > 50)"}`。预算超了直接报错，不静默超支。

## 12. 造不出来的

`AGENT_CAP`（1000 次）、`CONCURRENCY`（8 并发）、`agent({schema})` 不合法时重试一次、`workflow()` 只允许嵌套一层，这四条从 CLI 造不出来：示例 workflow 只用 11 次 `agent()`、mock runner 永远返回合法 JSON、registry 里也只有一个 workflow。它们由 `main.test.ts` 的「并发的 agent() 受 CONCURRENCY 限制」「schema 不合法时重试一次」「workflow() 只允许嵌套一层」几条用例覆盖，手工验证到此为止。

`deny` 名单同理：`createWorkflowRuntime` 的 `deny` 在本章入口里是空的，没有配置文件可以改，测试里传参覆盖。
