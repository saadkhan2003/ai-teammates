pub fn compare(current: &str, other: &str) -> Result<std::cmp::Ordering, semver::Error> {
    Ok(semver::Version::parse(current)?.cmp(&semver::Version::parse(other)?))
}
pub fn compatible(current: &str, min_compatible: &str) -> bool { compare(current, min_compatible).is_ok_and(|order| order != std::cmp::Ordering::Less) }
pub fn banner(current: &str, latest: &str) -> Option<String> {
    if compare(current, latest).is_ok_and(|order| order == std::cmp::Ordering::Less) { Some(format!("A new version is available ({latest}).")) } else { None }
}
#[cfg(test)] mod tests { use super::*; #[test] fn semver_comparison_and_banner(){assert_eq!(compare("1.2.0","1.3.0").unwrap(),std::cmp::Ordering::Less); assert_eq!(banner("0.4.0","0.5.0").as_deref(),Some("A new version is available (0.5.0).")); assert_eq!(banner("0.5.0","0.5.0"),None);} }
