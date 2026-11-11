use std::collections::HashSet;

const RECEIPT_PREFIX: &str = "[Compressed ";
const FINGERPRINT_NOTE: &str = "Fingerprints show head/tail only — every summary is stored in full. To retrieve a specific detail from a new block, call search_context({ query }) first; decompress only if the excerpt doesn't answer it.";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_CONTINUATIONS: usize = 3;

pub(crate) const CONTINUATION_PROMPT: &str = "<codeg-context-pruning-continuation>\nContext pruning has finished. The preceding compression receipt is internal bookkeeping, not a user request or a final answer. Continue the active task from the latest real user instruction and the retained context. Do not repeat the compression receipt or redo completed work. Preserve any pending question, approval, cancellation, and task scope; if the task is complete or needs user input, respond normally and stop.\n</codeg-context-pruning-continuation>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PruningReceipt {
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
            header: format!("{RECEIPT_PREFIX}{header}]"),
            detail: text.to_string(),
            blocks,
            saved_tokens,
        })
    }
}

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
            && (RECEIPT_PREFIX.starts_with(trimmed) || trimmed.starts_with(RECEIPT_PREFIX))
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
    seen: HashSet<String>,
}

impl PruningContinuation {
    pub(crate) fn for_prompt(text: &str) -> Self {
        let command = text.split_whitespace().next().unwrap_or("");
        Self {
            enabled: !matches!(command, "/compact" | "/compress" | "/clear")
                && !matches!(text.trim(), "压缩" | "压缩上下文"),
            seen: HashSet::new(),
        }
    }

    pub(crate) fn should_continue(&mut self, receipt: &PruningReceipt, clean_end: bool) -> bool {
        // 只延续明确的成功回执；重复或连续压缩必须停下，防止自动请求形成收费死循环。
        self.enabled
            && clean_end
            && self.seen.len() < MAX_CONTINUATIONS
            && self.seen.insert(receipt.header.clone())
    }

    pub(crate) fn has_continued(&self) -> bool {
        !self.seen.is_empty()
    }
}

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
