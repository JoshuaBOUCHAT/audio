fn main() {
    // serde sur User/Channel/Message : persistés en bincode dans OxidArt
    // (cf. architecture.md § Modèle de données), pas de conversion manuelle
    // vers un type parallèle rien que pour dériver Serialize/Deserialize.
    prost_build::Config::new()
        .type_attribute("chat.User", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(
            "chat.Channel",
            "#[derive(serde::Serialize, serde::Deserialize)]",
        )
        .type_attribute(
            "chat.Message",
            "#[derive(serde::Serialize, serde::Deserialize)]",
        )
        .type_attribute(
            "chat.Media",
            "#[derive(serde::Serialize, serde::Deserialize)]",
        )
        .type_attribute(
            "chat.Settings",
            "#[derive(serde::Serialize, serde::Deserialize)]",
        )
        .type_attribute(
            "chat.NotificationRule",
            "#[derive(serde::Serialize, serde::Deserialize)]",
        )
        .compile_protos(&["../proto/messages.proto"], &["../proto/"])
        .unwrap();
}
