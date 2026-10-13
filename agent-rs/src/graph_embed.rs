//! Local MiniLM sentence embeddings. Single CPU sentence, no padding, mean pooling,
//! L2 normalization. Weights are read into memory (no unsafe mapped mutable files).
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use std::path::Path;
use tokenizers::{Tokenizer, TruncationParams};

pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
}
impl Embedder {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let weights = dir.join("model.safetensors");
        if std::fs::metadata(&weights)
            .map_err(|e| e.to_string())?
            .len()
            > 512 * 1024 * 1024
        {
            return Err("embedding weights exceed the 512 MB safety limit".into());
        }
        let config: Config = serde_json::from_slice(
            &std::fs::read(dir.join("config.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if config.hidden_size != 384
            || config.num_hidden_layers != 6
            || config.max_position_embeddings > 512
        {
            return Err("expected the small 384-dimensional six-layer MiniLM model".into());
        }
        let mut tokenizer =
            Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| e.to_string())?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 256,
                ..Default::default()
            }))
            .map_err(|e| e.to_string())?;
        let bytes = std::fs::read(weights).map_err(|e| e.to_string())?;
        let vb = VarBuilder::from_buffered_safetensors(bytes, DTYPE, &Device::Cpu)
            .map_err(|e| e.to_string())?;
        let model = BertModel::load(vb, &config).map_err(|e| e.to_string())?;
        Ok(Self { model, tokenizer })
    }
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let input = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| e.to_string())?;
        let ids = input.get_ids();
        if ids.is_empty() {
            return Err("empty embedding input".into());
        }
        let ids = Tensor::new(ids, &Device::Cpu)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| e.to_string())?;
        let types = ids.zeros_like().map_err(|e| e.to_string())?;
        let hidden = self
            .model
            .forward(&ids, &types, None)
            .map_err(|e| e.to_string())?;
        let mut vector = (hidden.sum(1).map_err(|e| e.to_string())? / input.len() as f64)
            .and_then(|t| t.squeeze(0))
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| e.to_string())?;
        let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
        if !norm.is_finite() || norm == 0.0 {
            return Err("invalid embedding norm".into());
        }
        for x in &mut vector {
            *x /= norm;
        }
        Ok(vector)
    }
}
