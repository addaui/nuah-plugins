fn main() {
    println!("{}", serde_json::to_string_pretty(&registry::index()).expect("index serializes"));
}
