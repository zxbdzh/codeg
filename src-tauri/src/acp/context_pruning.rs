use std::collections::HashSet;

const RECEIPT_PREFIX: &str = "[Compressed ";
const STATUS_PREFIXES: [&str; 4] = [
    "ACTIVE SURFACE: ",
    "[acp-status]",
    "📊 [ACP] acp_status result:",
    "[ACP] acp_status result:",
];
const FINGERPRINT_NOTE: &str = "Fingerprints show head/tail only — every summary is stored in full. To retrieve a specific detail from a new block, call search_context({ query }) first; decompress only if the excerpt doesn't answer it.";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_CONTINUATIONS: usize = 3;

pub(crate) const CONTINUATION_PROMPT: &str = "<codeg-context-pruning-continuation>\nContext pruning has finished. The preceding compression receipt is internal bookkeeping, not a user request or a final answer. Continue the active task from the latest real user instruction and the retained context. Do not repeat the compression receipt or redo completed work. Preserve any pending question, approval, cancellation, and task scope; if the task is complete or needs user input, respond normally and stop.\n</codeg-context-pruning-continuation>";
pub(crate) const STATUS_CONTINUATION_PROMPT: &str = "<codeg-context-pruning-continuation>\nThe internal billion-context status query has finished. Its status report is tool output, not task completion or a new user instruction. Continue the active task from the latest real user instruction and retained context. Do not repeat the status report or redo completed work. Preserve pending questions, approvals, cancellation, and task scope; if the task is complete or needs user input, respond normally and stop.\n</codeg-context-pruning-continuation>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PruningReportKind {
    Compression,
    Status,
}

pub(crate) fn is_internal_continuation(text: &str) -> bool {
    matches!(text, CONTINUATION_PROMPT | STATUS_CONTINUATION_PROMPT)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PruningReceipt {
    pub(crate) kind: PruningReportKind,
    pub(crate) header: String,
    pub(crate) detail: String,
    pub(crate) blocks: u64,
    pub(crate) saved_tokens: u64,
}

impl PruningReceipt {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.len() > MAX_RECEIPT_BYTES {
            return None;
        }
        if !text.starts_with(RECEIPT_PREFIX) {
            return Self::parse_status(text);
        }
        let body = text.strip_prefix(RECEIPT_PREFIX)?;
        let (header, rest) = body.split_once(']')?;
        let (ranges, counts) = header.split_once(" → ")?;
        if !ranges.split(", ").all(valid_range) {
            return None;
        }
        let (blocks, savings) = counts.split_once(" block(s), ~")?;
        let blocks = blocks.parse::<u64>().ok().filter(|value| *value > 0)?;
        let (saved, _) = savings.split_once(" tokens saved.")?;
        let saved_tokens = saved.parse::<u64>().ok().filter(|value| *value > 0)?;
        // Bili 的完整指纹说明与固定回执头同时命中才接管，引用和普通压缩说明保留为正文。
        let (_, tail) = rest.split_once(FINGERPRINT_NOTE)?;
        let tail = tail.trim();
        if !tail.is_empty()
            && !(tail.starts_with("Current compressible ranges")
                && tail.ends_with("never split the batch across separate calls."))
        {
            return None;
        }
        Some(Self {
            kind: PruningReportKind::Compression,
            header: format!("{RECEIPT_PREFIX}{header}]"),
            detail: text.to_string(),
            blocks,
            saved_tokens,
        })
    }

    fn parse_status(text: &str) -> Option<Self> {
        let mut body = text;
        for prefix in ["📊 [ACP] acp_status result:", "[ACP] acp_status result:"] {
            if let Some(rest) = body.strip_prefix(prefix) {
                body = rest.trim();
                if !body.starts_with("[acp-status]") {
                    return None;
                }
                break;
            }
        }
        if let Some(rest) = body.strip_prefix("[acp-status]") {
            body = rest.trim_end().strip_suffix("[/acp-status]")?.trim();
        }
        let mut lines = body.lines();
        let surface = lines.next()?.strip_prefix("ACTIVE SURFACE: ")?;
        let host = surface
            .split(" | ")
            .find_map(|field| field.strip_prefix("host=billion-context "))?;
        if !host.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            return None;
        }
        let mut breakdown = false;
        let mut blocks = false;
        let mut billed = false;
        let mut storage = false;
        let mut section = false;
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            if line == "CONTEXT BREAKDOWN" {
                breakdown = true;
            } else if line == "COMPRESSED BLOCKS" || line.starts_with("COMPRESSED BLOCKS — ") {
                blocks = true;
            } else if let Some(count) = line.strip_prefix("BILLED INPUT (upstream usage): ") {
                count.split_whitespace().next()?.parse::<u64>().ok()?;
                billed = true;
            } else if line.starts_with("STORAGE — ") {
                storage = true;
            } else if line.starts_with("  ") && section {
                continue;
            } else if !STATUS_SECTIONS
                .iter()
                .any(|prefix| line.starts_with(prefix))
            {
                // 只接管当前 Bili 格式；未知段落或报告后的真实回答必须原样显示。
                return None;
            }
            section = true;
        }
        if !breakdown || !blocks || !billed || !storage {
            return None;
        }
        Some(Self {
            kind: PruningReportKind::Status,
            header: "billion-context acp_status".to_string(),
            detail: text.to_string(),
            blocks: 0,
            saved_tokens: 0,
        })
    }

    pub(crate) fn continuation_prompt(&self) -> &'static str {
        match self.kind {
            PruningReportKind::Compression => CONTINUATION_PROMPT,
            PruningReportKind::Status => STATUS_CONTINUATION_PROMPT,
        }
    }
}

const STATUS_SECTIONS: &[&str] = &[
    "Tip: call again with ",
    "NOTE: the token figures ",
    "Nudge: ",
    "Compressible ranges (",
    "Compressible ranges: ",
    "DEAD REFS — ",
    "PRE-COMPACTION ARCHIVE — ",
    "COMPRESSION CONFLICTS — ",
    "Every event above is an UNCONFIRMED signal: ",
    "Fix (",
    "Fix: ",
    "CONFIGURATION.md → ",
    "PCK SELF-STAMPING OFF BY DEFAULT (instance-level, #5079): ",
    "UNRECOGNIZED PATHS (instance-level): ",
    "UNDECRYPTED TRAFFIC (instance-level): ",
    "PRESSURE NOTE: ",
    "FOLD BASE GENERATION MISMATCH — ",
    "FOLD SUBSTRATE INVALID — ",
    "STORE (CCR) — ",
    "RETRIEVAL QUALITY — ",
    "BLOCK SPANS — ",
    "CRITICAL ADVISORY (instance-level): ",
    "CRITICAL UPDATE READY (instance-level): ",
    "CRITICAL UPDATE AVAILABLE (instance-level): ",
    "Last failures were attributed to ",
    "The Compressible-ranges list above was re-derived",
    "Live state: GET /__bili/status",
    "Update with: npm install -g billion-context@",
];

fn valid_range(range: &str) -> bool {
    let Some((start, end)) = range.split_once('–') else {
        return false;
    };
    let valid_ref = |value: &str| {
        value.strip_prefix('m').is_some_and(|digits| {
            digits.len() >= 4 && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
    };
    valid_ref(start) && valid_ref(end)
}

#[derive(Debug, Default)]
pub(crate) struct ReceiptStream {
    pending: String,
    prose: bool,
}

impl ReceiptStream {
    pub(crate) fn push(&mut self, text: &str) -> Option<String> {
        if self.prose {
            return Some(text.to_string());
        }
        self.pending.push_str(text);
        let trimmed = self.pending.trim_start();
        if self.pending.len() <= MAX_RECEIPT_BYTES
            && std::iter::once(RECEIPT_PREFIX)
                .chain(STATUS_PREFIXES)
                .any(|prefix| prefix.starts_with(trimmed) || trimmed.starts_with(prefix))
        {
            return None;
        }
        self.prose = true;
        Some(std::mem::take(&mut self.pending))
    }

    pub(crate) fn finish(&mut self) -> (Option<PruningReceipt>, String) {
        let pending = std::mem::take(&mut self.pending);
        self.prose = false;
        match PruningReceipt::parse(&pending) {
            Some(receipt) => (Some(receipt), String::new()),
            None => (None, pending),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PruningContinuation {
    enabled: bool,
    status_enabled: bool,
    seen: HashSet<String>,
}

impl PruningContinuation {
    pub(crate) fn for_prompt(text: &str) -> Self {
        let command = text.split_whitespace().next().unwrap_or("");
        let status_query = matches!(
            text.trim().to_lowercase().as_str(),
            "acp_status"
                | "/acp_status"
                | "/status"
                | "查看压缩状态"
                | "显示上下文状态"
                | "查看上下文状态"
                | "show compression status"
                | "show context status"
        ) || (text.trim().starts_with("acp_status(")
            && text.trim().ends_with(')'));
        Self {
            enabled: !matches!(command, "/compact" | "/compress" | "/clear")
                && !matches!(text.trim(), "压缩" | "压缩上下文"),
            status_enabled: !status_query,
            seen: HashSet::new(),
        }
    }

    pub(crate) fn should_continue(&mut self, receipt: &PruningReceipt, clean_end: bool) -> bool {
        // 工具回执可能只结束了中间步骤；重复结果及连续续接必须停下，防止形成收费死循环。
        self.enabled
            && (receipt.kind != PruningReportKind::Status || self.status_enabled)
            && clean_end
            && self.seen.len() < MAX_CONTINUATIONS
            && self.seen.insert(match receipt.kind {
                PruningReportKind::Compression => receipt.header.clone(),
                PruningReportKind::Status => receipt.detail.clone(),
            })
    }

    pub(crate) fn has_continued(&self) -> bool {
        !self.seen.is_empty()
    }
}

#[cfg(test)]
pub(crate) const TEST_STATUS_REPORT: &str = concat!(
    "ACTIVE SURFACE: pack=default | host=billion-context 0.1.213 (133f3525c)\n\n",
    "CONTEXT BREAKDOWN\n",
    "  27.8K tool (33%) | 52.2K text (62%) | 4.7K summaries (6%)\n",
    "  Top tools: text (62%), Bash (23%)\n\n",
    "COMPRESSED BLOCKS — 3 active (4.7K summary, 116.3K original)\n",
    "  b5 (T1) 49.9K→1.4K 52 msgs \"Retained research\"\n\n",
    "Tip: call again with scope:\"uncompressed\", view:\"messages\", tool:\"text\" for a per-message listing\n\n",
    "BILLED INPUT (upstream usage): 160601 tok · est-view total 112428 tok · ratio 1.4×\n\n",
    "Nudge: idle — growth -80957 < floor 22500, ready: T1 62725, blocked: T1 (cadence)\n\n",
    "Compressible ranges (1, oldest first):\n",
    "  m00402–m00503 31 msgs 48.2K [tool 85% | text 15%]\n\n",
    "DEAD REFS — 149 ref(s) no longer back any visible or folded message.\n\n",
    "STORAGE — storage: full (unified-first reads, dual-write)\n\n",
    "PRE-COMPACTION ARCHIVE — 1 block(s): content left the session history.\n",
    "  1: content replaced by client native compaction summary\n\n",
    "COMPRESSION CONFLICTS — 1 event(s) in this session.\n",
    "  [2026-11-11 13:45:41Z] unannounced-rewrite — 3/15 incoming message(s) carry pre-turn refs\n",
    "Every event above is an UNCONFIRMED signal: history changes were observed.\n\n",
    "Fix (claude): launch through bili claude.\n",
    "CONFIGURATION.md → \"Detecting other compression plugins (#1206)\"\n\n",
    "UNRECOGNIZED PATHS (instance-level): 62 request(s) matched no known protocol."
);

#[cfg(test)]
pub(crate) const TEST_RECEIPT: &str = concat!(
    "[Compressed m00130–m00148, m00150–m00153 → 2 block(s), ~5826 tokens saved.]\n",
    " · b7 full summary 520ch · head \"TASK AS OF THIS BLOCK\" … tail \"continue research\"\n",
    "Fingerprints show head/tail only — every summary is stored in full. To retrieve a specific detail from a new block, call search_context({ query }) first; decompress only if the excerpt doesn't answer it.\n\n",
    "Current compressible ranges (use these refs exactly as listed). ONE call, ONE string — never split the batch across separate calls."
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn billion_context_status_report_resumes_the_active_task() {
        let report = PruningReceipt::parse(TEST_STATUS_REPORT)
            .expect("acp_status output is internal tool output, not a final answer");
        assert!(
            PruningContinuation::for_prompt("Continue implementing the gateway")
                .should_continue(&report, true)
        );
        assert_eq!(report.kind, PruningReportKind::Status);
        assert!(is_internal_continuation(report.continuation_prompt()));
        assert_eq!(report.continuation_prompt(), STATUS_CONTINUATION_PROMPT);
    }

    #[test]
    fn billion_context_status_stream_reassembles_every_character_boundary() {
        for report in [
            TEST_STATUS_REPORT.to_string(),
            format!(
                "\n📊 [ACP] acp_status result:\n[acp-status]\n{TEST_STATUS_REPORT}\n[/acp-status]\n"
            ),
        ] {
            for split in report.char_indices().map(|(index, _)| index) {
                let mut stream = ReceiptStream::default();
                assert!(stream.push(&report[..split]).is_none(), "split={split}");
                assert!(stream.push(&report[split..]).is_none(), "split={split}");
                let (parsed, prose) = stream.finish();
                assert!(parsed.is_some(), "split={split}");
                assert!(prose.is_empty());
            }
        }
    }

    #[test]
    fn billion_context_status_queries_do_not_restart_the_task() {
        let report = PruningReceipt::parse(TEST_STATUS_REPORT).unwrap();
        for prompt in [
            "acp_status",
            "/acp_status",
            "查看压缩状态",
            "显示上下文状态",
            "Show compression status",
        ] {
            assert!(
                !PruningContinuation::for_prompt(prompt).should_continue(&report, true),
                "{prompt}"
            );
        }
    }

    #[test]
    fn billion_context_status_quotes_and_trailing_answers_remain_prose() {
        for text in [
            format!("> {TEST_STATUS_REPORT}"),
            format!("{TEST_STATUS_REPORT}\n\nThe gateway is ready."),
        ] {
            assert!(PruningReceipt::parse(&text).is_none());
        }
        assert!(
            PruningReceipt::parse("ACTIVE SURFACE: host=another-tool\nCONTEXT BREAKDOWN").is_none()
        );
    }

    #[test]
    fn billion_context_status_repetitions_and_changes_share_the_continuation_budget() {
        let report = PruningReceipt::parse(TEST_STATUS_REPORT).unwrap();
        let mut continuation = PruningContinuation::for_prompt("Continue research");
        assert!(!continuation.has_continued());
        assert!(!continuation.should_continue(&report, false));
        assert!(continuation.should_continue(&report, true));
        assert!(continuation.has_continued());
        assert!(!continuation.should_continue(&report, true));
        for tokens in [160602, 160603] {
            let report =
                PruningReceipt::parse(&TEST_STATUS_REPORT.replace("160601", &tokens.to_string()))
                    .unwrap();
            assert!(continuation.should_continue(&report, true));
        }
        let report =
            PruningReceipt::parse(&TEST_STATUS_REPORT.replace("160601", "160604")).unwrap();
        assert!(!continuation.should_continue(&report, true));
    }

    #[test]
    fn billion_context_receipt_is_bookkeeping_that_needs_continuation() {
        let receipt = PruningReceipt::parse(TEST_RECEIPT).unwrap();
        assert_eq!(receipt.blocks, 2);
        assert_eq!(receipt.saved_tokens, 5826);
        assert!(PruningContinuation::for_prompt("Continue the research")
            .should_continue(&receipt, true));
    }

    #[test]
    fn receipt_stream_reassembles_every_character_boundary_without_leaking_text() {
        for split in TEST_RECEIPT.char_indices().map(|(index, _)| index) {
            let mut stream = ReceiptStream::default();
            assert!(stream.push(&TEST_RECEIPT[..split]).is_none());
            assert!(stream.push(&TEST_RECEIPT[split..]).is_none());
            let (receipt, prose) = stream.finish();
            assert!(receipt.is_some(), "split={split}");
            assert!(prose.is_empty());
        }
    }

    #[test]
    fn ordinary_prose_and_quoted_receipts_are_forwarded_unchanged() {
        for text in [
            "Normal answer",
            "[Compression is useful]",
            &format!("> {TEST_RECEIPT}"),
        ] {
            let mut stream = ReceiptStream::default();
            assert_eq!(stream.push(text).as_deref(), Some(text));
            assert_eq!(stream.push(" tail").as_deref(), Some(" tail"));
            assert_eq!(stream.finish(), (None, String::new()));
        }
    }

    #[test]
    fn incomplete_unverified_and_oversized_receipts_remain_prose() {
        for text in [
            "[Compressed ",
            "[Compressed m00130–m00148 → 2 block(s), ~5826 tokens saved.]",
        ] {
            let mut stream = ReceiptStream::default();
            assert!(stream.push(text).is_none());
            assert_eq!(stream.finish(), (None, text.to_string()));
        }
        let oversized = format!("[Compressed {}", "x".repeat(MAX_RECEIPT_BYTES));
        let mut stream = ReceiptStream::default();
        assert_eq!(stream.push(&oversized), Some(oversized));
        assert_eq!(stream.finish(), (None, String::new()));
    }

    #[test]
    fn ordinary_answer_after_a_receipt_is_not_bookkeeping() {
        assert!(
            PruningReceipt::parse(&format!("{TEST_RECEIPT}\n\nThe task is complete.")).is_none()
        );
        let without_ranges = TEST_RECEIPT.split("\n\nCurrent").next().unwrap();
        assert!(
            PruningReceipt::parse(&format!("{without_ranges}\n\nThe task is complete.")).is_none()
        );
    }

    #[test]
    fn cancelled_failed_and_manual_compaction_never_continue() {
        let receipt = PruningReceipt::parse(TEST_RECEIPT).unwrap();
        assert!(
            !PruningContinuation::for_prompt("Continue research").should_continue(&receipt, false)
        );
        for prompt in [
            "/compact",
            "/compact focus on APIs",
            "/compress",
            "/clear",
            "压缩",
            "压缩上下文",
        ] {
            assert!(!PruningContinuation::for_prompt(prompt).should_continue(&receipt, true));
        }
    }

    #[test]
    fn repeated_receipts_and_long_compression_runs_are_bounded() {
        let receipt = PruningReceipt::parse(TEST_RECEIPT).unwrap();
        let mut continuation = PruningContinuation::for_prompt("Continue");
        assert!(continuation.should_continue(&receipt, true));
        assert!(!continuation.should_continue(&receipt, true));
        for blocks in 3..=4 {
            let receipt = PruningReceipt::parse(
                &TEST_RECEIPT.replace("2 block(s)", &format!("{blocks} block(s)")),
            )
            .unwrap();
            assert!(continuation.should_continue(&receipt, true));
        }
        let receipt =
            PruningReceipt::parse(&TEST_RECEIPT.replace("2 block(s)", "5 block(s)")).unwrap();
        assert!(!continuation.should_continue(&receipt, true));
        assert!(CONTINUATION_PROMPT.contains("latest real user instruction"));
    }
}
