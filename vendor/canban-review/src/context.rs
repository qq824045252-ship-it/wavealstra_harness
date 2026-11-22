// Copyright 2026 JJy <jjyruby@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Adapted from the gap expansion in crates/ui/src/review/context.rs.
use crate::model::GapExpansion;
use serde::Deserialize;

pub const CONTEXT_STEP: u64 = 20;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExpandDirection {
    Up,
    Down,
    All,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GapKind {
    Leading,
    Between,
    Trailing,
}

pub fn expand_gap(
    gap: GapKind,
    gap_len: u64,
    mut entry: GapExpansion,
    direction: ExpandDirection,
) -> GapExpansion {
    match gap {
        GapKind::Leading => {
            let rem = gap_len.saturating_sub(entry.from_bottom);
            let step = if direction == ExpandDirection::All {
                rem
            } else {
                rem.min(CONTEXT_STEP)
            };
            entry.from_bottom = (entry.from_bottom + step).min(gap_len);
        }
        GapKind::Between => {
            entry.from_top = entry.from_top.min(gap_len);
            entry.from_bottom = entry.from_bottom.min(gap_len - entry.from_top);
            let rem = gap_len.saturating_sub(entry.from_top + entry.from_bottom);
            match direction {
                ExpandDirection::Up => {
                    entry.from_bottom = (entry.from_bottom + rem.min(CONTEXT_STEP))
                        .min(gap_len - entry.from_top);
                }
                ExpandDirection::Down => {
                    entry.from_top = (entry.from_top + rem.min(CONTEXT_STEP))
                        .min(gap_len - entry.from_bottom);
                }
                ExpandDirection::All => {
                    entry.from_bottom = (entry.from_bottom + rem).min(gap_len - entry.from_top);
                }
            }
        }
        GapKind::Trailing => {
            let rem = gap_len.saturating_sub(entry.from_top);
            let step = if direction == ExpandDirection::All {
                rem
            } else {
                rem.min(CONTEXT_STEP)
            };
            entry.from_top = (entry.from_top + step).min(gap_len);
        }
    }
    entry
}
