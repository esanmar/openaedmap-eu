import type { FC } from "react";
import { Navbar } from "react-bulma-components";
import LanguageSwitcher from "./languageSwitcher";
import "./navbar.css";

const SiteNavbar: FC<SiteNavbarProps> = () => {
	return (
		<Navbar className="has-background-success">
			<Navbar.Brand>
				<Navbar.Item renderAs="a" href="/" pr={1} pl={1}>
					
				</Navbar.Item>
				<LanguageSwitcher />
			</Navbar.Brand>
		</Navbar>
	);
};

interface SiteNavbarProps {
	toggleSidebarShown: () => void;
}

export default SiteNavbar;
