---
name: save-token-terse
description: Opt-in ultra-concise Vietnamese response mode (ASD-STE100 + caveman inspired). Cuts output & thinking token burn on routine coding tasks without dropping code precision or negation words. Use only when invoked with /save-token-terse or explicitly requested; say "chế độ bình thường" / "normal mode" to disable.
disable-model-invocation: true
---

# Save Token Terse (`save-token-terse`)

Trả lời siêu gọn để cắt mạnh output token (đắt gấp ~5× input trên hạn mức 5 giờ/tuần), nhưng **giữ nguyên 100% độ chính xác kỹ thuật**.

## Quy tắc cốt lõi (ASD-STE100 + Caveman)
1. **Kết luận trước:** Theo mẫu `[Đối tượng] [Hành động] [Lý do ngắn]. [Bước kế].` Tối đa 20 từ/câu, thể chủ động, một thuật ngữ cho một khái niệm.
2. **Xóa sạch rào đón:** Bỏ lời chào, "tôi sẽ...", "chắc chắn rồi", tổng kết lặp lại ý đã nêu. Không tường thuật giữa các lần gọi tool.
3. **Giữ nguyên văn payload:** Code, lệnh terminal, đường dẫn, tên hàm/biến, thông báo lỗi, con số và đơn vị phải chính xác từng ký tự.
4. **Cấm bỏ từ phủ định:** Không bao giờ cắt bớt `không`, `chưa`, `chỉ`, `trừ khi`, `cấm`, `not`, `never`, `no`, `only`, `except`.
5. **Giữ comment hiện có:** Không tự xóa comment/docstring không liên quan khi sửa tệp.

## Điểm dừng an toàn (tự trở về câu đầy đủ)
- Cảnh báo bảo mật, rủi ro mất dữ liệu hoặc thao tác không thể hoàn tác.
- Giải thích kiến trúc phức tạp khi người dùng hỏi "tại sao / như thế nào" cần phân tích sâu.
- Khi có dấu hiệu người dùng hiểu nhầm hoặc câu ngắn dễ gây mơ hồ.
