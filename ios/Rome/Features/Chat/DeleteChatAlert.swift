import SwiftUI

extension View {
    /// Asks before a chat is deleted for good. An alert, not an action sheet:
    /// on current iOS an action sheet opens as a popover and drops Cancel.
    func deleteChatAlert(isPresented: Binding<Bool>, onDelete: @escaping () -> Void) -> some View {
        alert("Delete this chat?", isPresented: isPresented) {
            Button("Delete", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
    }
}
